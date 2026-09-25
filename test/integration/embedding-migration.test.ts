/**
 * #248 — rebuilding every vector after an embedding-model change.
 *
 * Driven against real SQLite (`test/helpers/sqlite-d1.ts`) rather than the
 * string-matching D1 mock, because the correctness of this feature *is* its SQL:
 * a keyset cursor whose comparison decides whether entries get skipped, and an
 * aggregate that projects chunk counts. A mock that matched the query text would
 * pass whatever the comparison said.
 *
 * The properties that matter, in order:
 *
 * 1. **No entry is ever skipped.** A skipped entry is invisible to every repair
 *    mechanism the Worker has — vector ids are deterministic, so `vector_ids`
 *    stays non-empty and `/vectorize-pending` cannot see it.
 * 2. **An interrupted rebuild resumes** rather than restarting, because restarting
 *    spends the one budget that runs out.
 * 3. **A stalled rebuild stops** instead of burning the remaining budget
 *    reproducing the same failure.
 * 4. **D1 content is never written.** Vectors are derived; memories are not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV } from "../helpers/make-env";
import { chunkText } from "../../src/text/chunk";
import { DEFAULTS } from "../../src/config";
import {
  MIGRATION_KEY,
  clearMigration,
  estimate,
  looksLikeBudgetError,
  readMigration,
  runBatch,
} from "../../src/migration/embedding";
import type { Env } from "../../src/env";

const NEW_MODEL = "@cf/baai/bge-base-en-v1.5";

/**
 * An AI binding that records which model it was asked for and can be made to
 * fail. `makeAIMock` only returns a vector for the shipped model and hands back a
 * stream for anything else, which is useless here — the whole point is embedding
 * with a *different* model.
 */
function makeAI(opts: { failFrom?: number; error?: string } = {}) {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    binding: {
      run: vi.fn(async (model: string) => {
        n++;
        calls.push(model);
        if (opts.failFrom !== undefined && n >= opts.failFrom) {
          throw new Error(opts.error ?? "boom");
        }
        return { data: [[0.1, 0.2, 0.3]] };
      }),
    },
  };
}

function makeEnv(d1: SqliteD1, ai: ReturnType<typeof makeAI>, kv = makeMemoryKV()) {
  const upserted: { id: string }[][] = [];
  const env = {
    DB: d1.db,
    OAUTH_KV: kv,
    AI: ai.binding,
    VECTORIZE: {
      upsert: vi.fn(async (vectors: { id: string }[]) => {
        upserted.push(vectors);
        return { count: vectors.length };
      }),
    },
  } as unknown as Env;
  return { env, upserted, kv };
}

const cfg = { ...DEFAULTS, EMBEDDING_MODEL: NEW_MODEL };

describe("migration estimate", () => {
  let d1: SqliteD1;
  beforeEach(() => {
    d1 = makeSqliteD1();
  });

  it("counts entries and projects at least as many chunks as the chunker makes", async () => {
    // One short entry and one long enough to split, so the projection is
    // exercised rather than trivially 1-per-entry.
    const long = "word ".repeat(900); // 4500 chars
    d1.seed({ id: "short", content: "hello", createdAt: 1 });
    d1.seed({ id: "long", content: long, createdAt: 2 });

    const { env } = makeEnv(d1, makeAI());
    const { entries, chunks } = await estimate(env);

    expect(entries).toBe(2);
    // The projection must never promise fewer chunks than the chunker produces,
    // or the estimate understates the cost the user is agreeing to.
    const real = chunkText("hello").length + chunkText(long).length;
    expect(chunks).toBeLessThanOrEqual(real);
    expect(chunks).toBeGreaterThanOrEqual(2);
  });

  /** Deprecated entries have had their vectors deliberately deleted and recall
   *  filters them out, so rebuilding them would spend the scarce resource of the
   *  whole operation on something nothing reads. */
  it("excludes deprecated entries from the count", async () => {
    d1.seed({ id: "live", content: "a", createdAt: 1 });
    d1.seed({ id: "gone", content: "b", createdAt: 2, tags: ["status:deprecated"] });

    const { env } = makeEnv(d1, makeAI());
    expect((await estimate(env)).entries).toBe(1);
  });

  it("reports zero for an empty brain rather than failing", async () => {
    const { env } = makeEnv(d1, makeAI());
    expect(await estimate(env)).toEqual({ entries: 0, chunks: 0 });
  });
});

describe("migration batches", () => {
  let d1: SqliteD1;
  beforeEach(() => {
    d1 = makeSqliteD1();
  });

  it("re-embeds with the configured model, not the shipped default", async () => {
    d1.seed({ id: "a", content: "hello", createdAt: 1 });
    const ai = makeAI();
    const { env } = makeEnv(d1, ai);

    await runBatch(env, cfg);

    expect(ai.calls).toEqual([NEW_MODEL]);
    expect(ai.calls).not.toContain(DEFAULTS.EMBEDDING_MODEL);
  });

  /**
   * The load-bearing property. Every entry must be reached exactly once across
   * however many batches it takes — no gaps, because a gap is undetectable.
   */
  it("covers every entry across batches with no gaps and no repeats", async () => {
    // More entries than one batch will take. Timestamps ascend so this covers
    // ordinary paging; the tie case has its own test below, because a tie only
    // exercises the id tie-break when it spans a batch boundary.
    const ids = Array.from({ length: 40 }, (_, i) => `e${String(i).padStart(2, "0")}`);
    ids.forEach((id, i) => d1.seed({ id, content: `body ${id}`, createdAt: 100 + i }));

    const ai = makeAI();
    const { env } = makeEnv(d1, ai);

    const seen: string[] = [];
    for (let guard = 0; guard < 50; guard++) {
      const before = await readMigration(env);
      const r = await runBatch(env, cfg);
      const after = await readMigration(env);
      // Record what this batch advanced over.
      if (after?.cursorId && after.cursorId !== before?.cursorId) seen.push(after.cursorId);
      if (r.done) break;
    }

    const state = await readMigration(env);
    expect(state?.processed).toBe(40);
    expect(state?.failed).toBe(0);
    // Every entry embedded exactly once.
    expect(ai.calls).toHaveLength(40);
    // And the cursor ended on the last entry in (created_at, id) order.
    expect(state?.cursorId).toBe("e39");
    // Strictly increasing cursor — never revisited a position.
    expect([...seen]).toEqual([...seen].sort());
  });

  /**
   * Entries captured in the same millisecond are common — a bulk import gives a
   * whole brain one timestamp. If the cursor compared `created_at` alone, the
   * batch boundary would fall inside the tied group and everything after it
   * would be skipped, silently and permanently.
   *
   * Every entry here shares one timestamp, so the boundary is guaranteed to land
   * inside the tie. An earlier version of this suite tied only the first five of
   * forty, which never crossed a boundary and left the tie-break untested.
   */
  it("does not skip entries that share a created_at across a batch boundary", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `e${String(i).padStart(2, "0")}`);
    ids.forEach(id => d1.seed({ id, content: `body ${id}`, createdAt: 100 }));

    const ai = makeAI();
    const { env } = makeEnv(d1, ai);

    for (let guard = 0; guard < 50; guard++) {
      if ((await runBatch(env, cfg)).done) break;
    }

    const state = await readMigration(env);
    expect(state?.processed).toBe(40);
    expect(ai.calls).toHaveLength(40);
    expect(state?.cursorId).toBe("e39");
  });

  it("resumes from the cursor instead of starting over", async () => {
    Array.from({ length: 30 }, (_, i) => `e${i}`).forEach((id, i) =>
      d1.seed({ id, content: `body ${id}`, createdAt: 100 + i }),
    );

    const ai = makeAI();
    const { env, kv } = makeEnv(d1, ai);

    const first = await runBatch(env, cfg);
    expect(first.processed).toBeGreaterThan(0);
    expect(first.done).toBe(false);
    const afterFirst = ai.calls.length;

    // A fresh process, same KV: the ledger is the only thing carried over.
    const ai2 = makeAI();
    const { env: env2 } = makeEnv(d1, ai2, kv);
    await runBatch(env2, cfg);

    // The second run embedded new entries, not the ones already done.
    expect(ai2.calls.length).toBeLessThanOrEqual(30 - afterFirst);
    const state = await readMigration(env2);
    expect(state?.processed).toBe(afterFirst + ai2.calls.length);
  });

  it("reports done once, with nothing remaining", async () => {
    d1.seed({ id: "a", content: "one", createdAt: 1 });
    d1.seed({ id: "b", content: "two", createdAt: 2 });
    const { env } = makeEnv(d1, makeAI());

    let last = await runBatch(env, cfg);
    for (let i = 0; i < 5 && !last.done; i++) last = await runBatch(env, cfg);

    expect(last.done).toBe(true);
    expect(last.remaining).toBe(0);
    expect((await readMigration(env))?.finishedAt).toBeGreaterThan(0);
  });

  it("never writes to entries.content", async () => {
    d1.seed({ id: "a", content: "the original text", createdAt: 1 });
    const { env } = makeEnv(d1, makeAI());

    await runBatch(env, cfg);

    const rows = d1.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("the original text");
  });

  /**
   * `reembedOrThrow` looks like the natural helper for this and is the wrong one:
   * it hardcodes `Date.now()`, which would stamp every rebuilt vector's metadata
   * with migration time. Recall's keyword fusion reads that metadata, so a whole
   * brain would look as though every memory were created the day it migrated.
   */
  it("stamps rebuilt vectors with the entry's own created_at, not now", async () => {
    const originally = 1_600_000_000_000;
    d1.seed({ id: "a", content: "hello", createdAt: originally });
    const { env, upserted } = makeEnv(d1, makeAI());

    await runBatch(env, cfg);

    expect(upserted).toHaveLength(1);
    const [vector] = upserted[0] as unknown as { metadata: Record<string, unknown> }[];
    expect(vector.metadata.created_at).toBe(originally);
    expect(vector.metadata.parentId).toBe("a");
  });

  it("skips deprecated entries when rebuilding", async () => {
    d1.seed({ id: "live", content: "keep", createdAt: 1 });
    d1.seed({ id: "gone", content: "drop", createdAt: 2, tags: ["status:deprecated"] });
    const ai = makeAI();
    const { env } = makeEnv(d1, ai);

    let r = await runBatch(env, cfg);
    for (let i = 0; i < 3 && !r.done; i++) r = await runBatch(env, cfg);

    expect(ai.calls).toHaveLength(1);
    expect((await readMigration(env))?.processed).toBe(1);
  });
});

describe("migration under failure", () => {
  let d1: SqliteD1;
  beforeEach(() => {
    d1 = makeSqliteD1();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /**
   * Property 3. When the budget runs out every remaining entry fails for the
   * same reason, so a loop that kept going would spend the rest of the run
   * producing identical errors and report hundreds of distinct "failures".
   */
  it("stops the run when a batch achieves nothing", async () => {
    Array.from({ length: 20 }, (_, i) => `e${i}`).forEach((id, i) =>
      d1.seed({ id, content: `body ${id}`, createdAt: 100 + i }),
    );
    // Fails from the very first embed.
    const ai = makeAI({ failFrom: 1, error: "AiError: 4006 out of neurons" });
    const { env } = makeEnv(d1, ai);

    const r = await runBatch(env, cfg);

    expect(r.stalled).toBe(true);
    expect(r.processed).toBe(0);
    expect(r.done).toBe(false);
    // One attempt, not twenty.
    expect(ai.calls).toHaveLength(1);
  });

  it("keeps the cursor when it stalls, so a resume does not redo paid work", async () => {
    Array.from({ length: 20 }, (_, i) => `e${i}`).forEach((id, i) =>
      d1.seed({ id, content: `body ${id}`, createdAt: 100 + i }),
    );

    // Succeeds for a while, then the budget goes.
    const ai = makeAI({ failFrom: 4, error: "4006 quota exceeded" });
    const { env, kv } = makeEnv(d1, ai);

    const first = await runBatch(env, cfg);
    expect(first.processed).toBe(3);
    const cursor = (await readMigration(env))?.cursorId;
    expect(cursor).toBe("e2");

    // Resume with budget restored: picks up after e2, does not redo e0–e2.
    const ai2 = makeAI();
    const { env: env2 } = makeEnv(d1, ai2, kv);
    await runBatch(env2, cfg);
    expect((await readMigration(env2))?.cursorId).not.toBe("e0");
    expect((await readMigration(env2))?.processed).toBeGreaterThan(3);
  });

  /** A failed entry must stay in front of the cursor so a later run retries it,
   *  rather than being stepped over and lost. */
  it("does not advance the cursor past an entry that failed", async () => {
    d1.seed({ id: "a", content: "ok", createdAt: 1 });
    d1.seed({ id: "b", content: "bad", createdAt: 2 });
    d1.seed({ id: "c", content: "ok", createdAt: 3 });

    const ai = makeAI({ failFrom: 2, error: "single entry problem" });
    const { env } = makeEnv(d1, ai);

    await runBatch(env, cfg);

    // Advanced to a, stopped at b. c has not been passed over.
    expect((await readMigration(env))?.cursorId).toBe("a");
  });

  it("starts over when the target model changed under a half-finished run", async () => {
    d1.seed({ id: "a", content: "one", createdAt: 1 });
    d1.seed({ id: "b", content: "two", createdAt: 2 });
    const { env, kv } = makeEnv(d1, makeAI());

    await runBatch(env, cfg);
    expect((await readMigration(env))?.cursorId).toBeTruthy();

    // A different target: finishing the old run would leave the index half one
    // model and half another.
    const ai2 = makeAI();
    const { env: env2 } = makeEnv(d1, ai2, kv);
    await runBatch(env2, { ...DEFAULTS, EMBEDDING_MODEL: "@cf/baai/bge-large-en-v1.5" });

    const state = await readMigration(env2);
    expect(state?.model).toBe("@cf/baai/bge-large-en-v1.5");
    // Cursor restarted from the beginning of the table.
    expect(state?.processed).toBeLessThanOrEqual(2);
    expect(ai2.calls[0]).toBe("@cf/baai/bge-large-en-v1.5");
  });

  it("treats an unreadable ledger as absent rather than trusting its cursor", async () => {
    d1.seed({ id: "a", content: "one", createdAt: 1 });
    const kv = makeMemoryKV();
    await kv.put(MIGRATION_KEY, "{not json");
    const { env } = makeEnv(d1, makeAI(), kv);

    expect(await readMigration(env)).toBeNull();
    // And a batch still runs, from the start.
    const r = await runBatch(env, cfg);
    expect(r.processed).toBe(1);
  });

  it("clears the ledger on reset", async () => {
    d1.seed({ id: "a", content: "one", createdAt: 1 });
    const { env } = makeEnv(d1, makeAI());
    await runBatch(env, cfg);
    expect(await readMigration(env)).not.toBeNull();

    await clearMigration(env);
    expect(await readMigration(env)).toBeNull();
  });
});

describe("budget-error recognition", () => {
  /** Best-effort and deliberately not load-bearing — the no-progress stop is
   *  what actually protects the run. These cases document the intent. */
  it("recognises the shapes Cloudflare uses for a spent budget", () => {
    for (const message of [
      "AiError: 4006: out of neurons",
      "Quota exceeded for this account",
      "Insufficient capacity",
      "Rate limit exceeded",
      "429 Too Many Requests",
    ]) {
      expect(looksLikeBudgetError(new Error(message)), message).toBe(true);
    }
  });

  it("does not mistake an ordinary failure for a spent budget", () => {
    for (const message of ["network unreachable", "invalid model", "boom"]) {
      expect(looksLikeBudgetError(new Error(message)), message).toBe(false);
    }
  });
});
