import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWeeklyInsights, MAX_INSIGHTS_PER_RUN } from "../../src/insight/weekly";
import { resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const DAY = 86400000;
const NOW = 400 * DAY;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const GOOD = `{"insight": true, "shape": "contradiction", "text": "You set the pricing model flat for that tier and later reversed it to usage-based billing."}`;

/** The AI mock must serve three callers: embeddings, the classifier inside
 *  captureEntry (streaming SSE), and the reasoning call (also streaming). */
function makeAI(insightPayload: string) {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      // The reasoning prompt is the only one that mentions two memories.
      return sse(prompt.includes("Memory A:") ? insightPayload : "3");
    }),
  } as unknown as Ai;
}

/** Seed n candidates, each with both of its entries present. */
function seedCandidates(sqlite: SqliteD1, n: number) {
  for (let i = 0; i < n; i++) {
    sqlite.seed({
      id: `a-${i}`, createdAt: NOW - 120 * DAY, tags: ["pricing"],
      content: `Decision: price tier ${i} flat at nine dollars a month for predictable billing.`,
    });
    sqlite.seed({
      id: `b-${i}`, createdAt: NOW, tags: ["pricing"],
      content: `Decision: move tier ${i} to usage-based billing; flat pricing left money on the table.`,
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
    ).bind(`cand-${i}`, `a-${i}`, `b-${i}`, 120 * DAY, 10 - i, NOW).run();
  }
}

const statusOf = async (sqlite: SqliteD1, id: string) =>
  ((await sqlite.db.prepare(
    `SELECT status FROM insight_candidates WHERE id = ?`,
  ).bind(id).first()) as { status: string }).status;

const insightCount = async (sqlite: SqliteD1) =>
  ((await sqlite.db.prepare(
    `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%'`,
  ).first()) as { n: number }).n;

describe("runWeeklyInsights()", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    // initializeDatabase() memoizes its promise at module scope (src/db/init.ts)
    // so the runtime ALTERs (updated_at among them) only ever run once per
    // process. Each test here gets a brand new :memory: database, so without
    // this reset the second test to reach captureEntry's INSERT inherits a
    // stale "already migrated" memo for a database that was never altered.
    resetDatabaseInit();
    sqlite = makeSqliteD1();
  });

  afterEach(() => sqlite.close());

  it("writes at most MAX_INSIGHTS_PER_RUN even when every candidate qualifies", async () => {
    seedCandidates(sqlite, 8);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBeLessThanOrEqual(MAX_INSIGHTS_PER_RUN);
    expect(await insightCount(sqlite)).toBeGreaterThan(0);
  });

  it("writes nothing when every candidate is declined", async () => {
    seedCandidates(sqlite, 2);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(`{"insight": false}`), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(0);
  });

  it("marks a declined candidate rejected so it is never re-proposed", async () => {
    seedCandidates(sqlite, 1);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(`{"insight": false}`), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await statusOf(sqlite, "cand-0")).toBe("rejected");
  });

  it("marks an accepted candidate used", async () => {
    seedCandidates(sqlite, 1);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  it("marks a duplicate-blocked candidate used, not rejected, and writes nothing", async () => {
    // A blocked capture is not a refusal from reasonOverPair — the insight was
    // good, but captureEntry found it duplicates an earlier one. This is the
    // non-`stored` path ambiguity resolution #2 calls out: leaving the
    // candidate `pending` would re-propose and re-reason over the same pair
    // every week forever, so it must be `used` even though nothing was written.
    seedCandidates(sqlite, 1);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any,
      AI: makeAI(GOOD),
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "existing", score: 0.99, metadata: {} }] }),
      }),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(0);
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  it("skips a candidate whose entries have since been forgotten", async () => {
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('orphan', 'gone-a', 'gone-b', 0.9, 1, 9.0, 'vector', 'pending', ?)`,
    ).bind(NOW).run();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(0);
    expect(await statusOf(sqlite, "orphan")).toBe("pending");
  });

  it("does not throw when the pass fails", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); } } as any;
    await expect(
      runWeeklyInsights(makeTestEnv(undefined, { DB: broken, OAUTH_KV: makeMemoryKV() }), ctx),
    ).resolves.toBeUndefined();
  });
});
