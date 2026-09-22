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

  it("does not advance the cursor past a failed candidate, so it is retried", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "Follow up with the accountant", 1000);
    const kv = makeMemoryKV();
    const env = makeTestEnv(dbOf(sq) as any, {
      OAUTH_KV: kv,
      AI: { run: vi.fn().mockRejectedValue(new Error("AI down")) } as unknown as Ai,
    });

    const summary = await runWhenExtractPass(env, ctx, null);

    expect(summary.whenJudged).toBe(0);
    expect(await readWhenCursor(env)).toBeNull();
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
    expect(await readWhenCursor(env)).toBeNull();
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
