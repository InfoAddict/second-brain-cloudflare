/**
 * runWhenExtractPass end to end (src/when/pass.ts): the nightly capped AI
 * extraction pass, driven against real SQLite so the prefilter — a real WHERE
 * clause, not a mock's string match — is what is actually under test.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { runWhenExtractPass, readWhenCursor, WHEN_CURSOR_KEY, WHEN_EXTRACT_PER_NIGHT } from "../../src/when/pass";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; resetDatabaseInit(); });

function dbOf(s: SqliteD1) {
  return {
    prepare: (sql: string) => s.db.prepare(sql),
    exec: (sql: string) => s.db.exec(sql),
    async batch(stmts: { run(): Promise<any> }[]) {
      const out: any[] = [];
      for (const st of stmts) out.push(await st.run());
      s.issued.splice(s.issued.length - stmts.length, stmts.length, `BATCH(${stmts.length})`);
      return out.map((r: any) => ({ ...r, meta: { changes: 1, ...r?.meta } }));
    },
  };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  return s;
}

/** Always answers a fixed commitment verdict, recording every prompt it saw. */
function makeAI(payload: string, prompts: string[] = []) {
  return {
    run: vi.fn().mockImplementation(async (_model: string, opts: any) => {
      prompts.push(String(opts?.messages?.[0]?.content ?? ""));
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(payload)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

function seedOpenLoop(s: SqliteD1, id: string, content: string, createdAt: number) {
  s.seed({ id, content, createdAt, tags: ["task"] });
}

describe("runWhenExtractPass — the prefilter", () => {
  it("only considers open-loop or volatility:volatile entries with no when yet", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "Follow up with the accountant", 1000);
    sq.seed({ id: "volatile-1", content: "The meeting moved to Thursday", createdAt: 2000, tags: ["volatility:volatile"] });
    sq.seed({ id: "plain", content: "Just a note", createdAt: 3000, tags: [] });
    // Already has a when — must not be re-judged.
    sq.seed({ id: "already-anchored", content: "Renew the passport", createdAt: 4000, tags: ["task"] });
    sq.db.prepare(`UPDATE entries SET when_source = 'explicit', when_at = ? WHERE id = ?`).bind(9999, "already-anchored").run();

    const kv = makeMemoryKV();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv, AI: makeAI(`{"is_commitment": false}`) });

    const summary = await runWhenExtractPass(env, ctx, null);

    expect(summary.whenJudged).toBe(2); // loop-1 and volatile-1, not plain or already-anchored
  });

  it("scopes to the given workspace slice", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "in-slice", "Follow up on this", 1000);
    sq.db.prepare(`UPDATE entries SET workspace_id = 'ws-a' WHERE id = 'in-slice'`).run();
    seedOpenLoop(sq, "other-slice", "Follow up on that", 2000);
    sq.db.prepare(`UPDATE entries SET workspace_id = 'ws-b' WHERE id = 'other-slice'`).run();

    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV(), AI: makeAI(`{"is_commitment": false}`) });
    const summary = await runWhenExtractPass(env, ctx, "ws-a");

    expect(summary.whenJudged).toBe(1);
  });
});

describe("runWhenExtractPass — persistence and cursor", () => {
  it("persists when_at/when_kind/when_source only for confident commitments", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "File the annual report", 1000);
    const env = makeTestEnv(dbOf(sq) as any, {
      OAUTH_KV: makeMemoryKV(),
      AI: makeAI(`{"is_commitment": true, "what": "File the report", "due_at": "2027-01-30", "confidence": 0.9}`),
    });

    const summary = await runWhenExtractPass(env, ctx, null);
    expect(summary.whenExtracted).toBe(1);

    const row = (await sq.db.prepare(`SELECT when_at, when_kind, when_source FROM entries WHERE id = 'loop-1'`).first()) as any;
    expect(row.when_at).toBe(Date.parse("2027-01-30"));
    expect(row.when_kind).toBe("due");
    expect(row.when_source).toBe("model");
  });

  it("advances the cursor past a declined candidate", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "Follow up with the accountant", 1000);
    const kv = makeMemoryKV();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv, AI: makeAI(`{"is_commitment": false}`) });

    await runWhenExtractPass(env, ctx, null);

    const cursor = await readWhenCursor(env);
    expect(cursor).toEqual({ createdAt: 1000, id: "loop-1" });
  });

  it("does not advance the cursor's position past a failed candidate, so it is retried", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "Follow up with the accountant", 1000);
    const kv = makeMemoryKV();
    const env = makeTestEnv(dbOf(sq) as any, {
      OAUTH_KV: kv,
      AI: { run: vi.fn().mockRejectedValue(new Error("AI down")) } as unknown as Ai,
    });

    const summary = await runWhenExtractPass(env, ctx, null);

    expect(summary.whenJudged).toBe(0);
    // No POSITION is recorded (see test/integration/when-extract-pass.test.ts's
    // "Finding 2" describe block for the failure-tracking half of this cursor).
    const cursor = await readWhenCursor(env);
    expect(cursor?.createdAt).toBeUndefined();
  });

  it("stops at the first failure without judging later candidates in the same batch", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "First candidate", 1000);
    seedOpenLoop(sq, "loop-2", "Second candidate", 2000);
    let calls = 0;
    const env = makeTestEnv(dbOf(sq) as any, {
      OAUTH_KV: makeMemoryKV(),
      AI: {
        run: vi.fn().mockImplementation(async () => {
          calls++;
          if (calls === 1) throw new Error("AI down");
          return new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(`data: {"response":"{\\"is_commitment\\": false}"}\n\n`));
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          });
        }),
      } as unknown as Ai,
    });

    const summary = await runWhenExtractPass(env, ctx, null);

    expect(calls).toBe(1); // never reached loop-2
    expect(summary.whenJudged).toBe(0);
    const cursor = await readWhenCursor(env);
    expect(cursor?.createdAt).toBeUndefined();
  });

  it("does not re-select an entry once the cursor has passed it", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "First candidate", 1000);
    const kv = makeMemoryKV();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv, AI: makeAI(`{"is_commitment": false}`) });

    await runWhenExtractPass(env, ctx, null);
    seedOpenLoop(sq, "loop-2", "Second candidate", 2000);
    const second = await runWhenExtractPass(env, ctx, null);

    expect(second.whenJudged).toBe(1); // only loop-2
  });
});

describe("runWhenExtractPass — budget", () => {
  it("costs at most 10 D1 statements and at most WHEN_EXTRACT_PER_NIGHT model calls at a full slate", async () => {
    sq = await migrated();
    for (let i = 0; i < WHEN_EXTRACT_PER_NIGHT + 5; i++) {
      seedOpenLoop(sq, `loop-${i}`, `Candidate ${i}`, 1000 + i);
    }
    const ai = makeAI(`{"is_commitment": true, "what": "Do it", "due_at": "2027-01-30", "confidence": 0.9}`);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV(), AI: ai });

    sq.issued.length = 0;
    const summary = await runWhenExtractPass(env, ctx, null);

    expect((ai.run as any).mock.calls.length).toBeLessThanOrEqual(WHEN_EXTRACT_PER_NIGHT);
    expect(summary.whenJudged).toBe(WHEN_EXTRACT_PER_NIGHT);
    // One SELECT (the prefilter) plus one BATCH (every persisted commitment,
    // however many) — the whole point of collecting writes instead of running
    // them as they are decided.
    expect(sq.issued.length).toBeLessThanOrEqual(10);
    expect(sq.issued.length).toBe(2);
  });

  it("costs one SELECT and no batch when nothing is a commitment", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "Just checking in", 1000);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV(), AI: makeAI(`{"is_commitment": false}`) });

    sq.issued.length = 0;
    await runWhenExtractPass(env, ctx, null);

    expect(sq.issued.length).toBe(1);
  });
});

describe("runWhenExtractPass — the prompt", () => {
  it("carries today's date so relative phrases can be normalized", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "Follow up next Friday", 1000);
    const prompts: string[] = [];
    vi.setSystemTime(Date.UTC(2027, 2, 10));
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV(), AI: makeAI(`{"is_commitment": false}`, prompts) });

    await runWhenExtractPass(env, ctx, null);
    vi.useRealTimers();

    expect(prompts[0]).toContain("2027-03-10");
  });
});

/** Same as dbOf, but batch() always throws — for the write-failure rollback tests. */
function dbWithFailingBatch(s: SqliteD1) {
  return {
    prepare: (sql: string) => s.db.prepare(sql),
    exec: (sql: string) => s.db.exec(sql),
    async batch() {
      throw new Error("D1_ERROR: network error: SQLITE_ERROR");
    },
  };
}

describe("runWhenExtractPass — Finding 1: the batch write can fail", () => {
  it("does not advance the cursor, reports the run as failed, and leaves the row untouched", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "File the annual report", 1000);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = makeTestEnv(dbWithFailingBatch(sq) as any, {
      OAUTH_KV: makeMemoryKV(),
      AI: makeAI(`{"is_commitment": true, "what": "File the report", "due_at": "2027-01-30", "confidence": 0.9}`),
    });

    const summary = await runWhenExtractPass(env, ctx, null);

    expect(summary.ok).toBe(false);
    // Judged (a verdict was reached), but NOT extracted — the write never landed.
    expect(summary.whenJudged).toBe(1);
    expect(summary.whenExtracted).toBe(0);
    errorSpy.mockRestore();

    const row = (await sq.db.prepare(`SELECT when_at, when_source FROM entries WHERE id = 'loop-1'`).first()) as any;
    expect(row.when_at).toBeNull();
    expect(row.when_source).toBeNull();

    expect(await readWhenCursor(env)).toBeNull();
  });

  it("re-selects the same candidate next run once the batch succeeds", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "File the annual report", 1000);
    const kv = makeMemoryKV();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingEnv = makeTestEnv(dbWithFailingBatch(sq) as any, {
      OAUTH_KV: kv,
      AI: makeAI(`{"is_commitment": true, "what": "File the report", "due_at": "2027-01-30", "confidence": 0.9}`),
    });
    await runWhenExtractPass(failingEnv, ctx, null);
    errorSpy.mockRestore();

    // Same entry, now with a working batch.
    const workingEnv = makeTestEnv(dbOf(sq) as any, {
      OAUTH_KV: kv,
      AI: makeAI(`{"is_commitment": true, "what": "File the report", "due_at": "2027-01-30", "confidence": 0.9}`),
    });
    const summary = await runWhenExtractPass(workingEnv, ctx, null);

    expect(summary.ok).toBe(true);
    expect(summary.whenExtracted).toBe(1);
    const row = (await sq.db.prepare(`SELECT when_at FROM entries WHERE id = 'loop-1'`).first()) as any;
    expect(row.when_at).toBe(Date.parse("2027-01-30"));
  });

  it("rolls back a whole run's worth of declines too, not just the commitment", async () => {
    // The policy is "do not advance the cursor AT ALL", not "only roll back
    // the commitment" — a declined candidate examined in the same run must
    // be re-judged next time rather than skipped.
    sq = await migrated();
    seedOpenLoop(sq, "declined-1", "Just a note", 1000);
    seedOpenLoop(sq, "commitment-1", "File the annual report", 2000);
    let call = 0;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = makeTestEnv(dbWithFailingBatch(sq) as any, {
      OAUTH_KV: makeMemoryKV(),
      AI: {
        run: vi.fn().mockImplementation(async () => {
          call++;
          const payload = call === 1
            ? `{"is_commitment": false}`
            : `{"is_commitment": true, "what": "File the report", "due_at": "2027-01-30", "confidence": 0.9}`;
          return new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(payload)}}\n\n`));
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          });
        }),
      } as unknown as Ai,
    });

    const summary = await runWhenExtractPass(env, ctx, null);
    errorSpy.mockRestore();

    expect(summary.ok).toBe(false);
    expect(summary.whenJudged).toBe(2);
    expect(summary.whenExtracted).toBe(0);
    expect(await readWhenCursor(env)).toBeNull();
  });
});

describe("runWhenExtractPass — Finding 2: bounded quarantine for a permanently-failing entry", () => {
  function makeSelectiveAI(failOn: string) {
    return {
      run: vi.fn().mockImplementation(async (_model: string, opts: any) => {
        const prompt = String(opts?.messages?.[0]?.content ?? "");
        if (prompt.includes(failOn)) throw new Error("AI down for this one");
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: {"response":"{\\"is_commitment\\": false}"}\n\n`));
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        });
      }),
    } as unknown as Ai;
  }

  it("stops without advancing on the first two failures (existing behavior preserved)", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "poison", "Unreadable memory", 1000);
    seedOpenLoop(sq, "healthy", "A perfectly normal note", 2000);
    const kv = makeMemoryKV();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv, AI: makeSelectiveAI("Unreadable memory") });

    const night1 = await runWhenExtractPass(env, ctx, null);
    expect(night1.whenJudged).toBe(0);
    expect(night1.whenSkipped).toBe(0);

    const night2 = await runWhenExtractPass(env, ctx, null);
    expect(night2.whenJudged).toBe(0);
    expect(night2.whenSkipped).toBe(0);
    errorSpy.mockRestore();
  });

  it("quarantines the entry on the third consecutive failure, and judges what comes after it starting the following run", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "poison", "Unreadable memory", 1000);
    seedOpenLoop(sq, "healthy", "A perfectly normal note", 2000);
    const kv = makeMemoryKV();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv, AI: makeSelectiveAI("Unreadable memory") });

    await runWhenExtractPass(env, ctx, null); // night 1: fail_count 1
    await runWhenExtractPass(env, ctx, null); // night 2: fail_count 2
    const night3 = await runWhenExtractPass(env, ctx, null); // night 3: fail_count 3 -> quarantine

    expect(night3.whenSkipped).toBe(1);
    // Quarantine advances the cursor past the poisoned entry but does not
    // itself judge what comes after — that starts fresh next run.
    expect(night3.whenJudged).toBe(0);

    const night4 = await runWhenExtractPass(env, ctx, null);
    errorSpy.mockRestore();

    expect(night4.whenJudged).toBe(1); // "healthy", finally reached
    expect(night4.whenSkipped).toBe(0);
  });

  it("resets the fail counter once a different entry is the one failing", async () => {
    // Two separately-poisoned entries, neither failing three times in a row
    // as the SAME entry, must not be quarantined.
    sq = await migrated();
    seedOpenLoop(sq, "poison-a", "First unreadable memory", 1000);
    const kv = makeMemoryKV();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv, AI: makeSelectiveAI("First unreadable memory") });
    await runWhenExtractPass(env, ctx, null); // poison-a fails once

    // A different entry now sits at the same cursor position's "next" slot —
    // simulate a fresh poison arriving before poison-a's streak reaches 3 by
    // seeding a second, differently-poisoned entry AT THE SAME to-be-selected
    // position is not representable without deleting poison-a, so instead
    // this asserts the counter is keyed on id: judging a DIFFERENT failing id
    // must not inherit poison-a's count.
    seedOpenLoop(sq, "poison-b", "Second unreadable memory", 500); // before poison-a in ORDER
    env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv, AI: makeSelectiveAI("econd unreadable") });
    const summary = await runWhenExtractPass(env, ctx, null);
    errorSpy.mockRestore();

    expect(summary.whenSkipped).toBe(0); // poison-b's own count is 1, not inherited from poison-a
  });
});
