import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runInsightAccrual, ACCRUAL_CURSOR_KEY } from "../../src/insight/candidates";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const DAY = 86400000;
const NOW = 400 * DAY;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const SEED_TEXT = "A long enough decision about the pricing model to clear the eligibility floor, in full.";
const OLD_TEXT = "An earlier position on how the pricing model should work, written at real length.";

/** One neighbour, described the way Vectorize returns it. */
function match(over: Record<string, any> = {}) {
  return {
    id: "vec-old-1",
    score: 0.87,
    metadata: {
      parentId: "old-1",
      created_at: NOW - 90 * DAY,
      tags: ["pricing"],
      content: OLD_TEXT,
      source: "claude-desktop",
      ...(over.metadata ?? {}),
    },
    ...over,
  };
}

function makeEnv(sqlite: SqliteD1, matches: any[], kv = makeMemoryKV()): Env {
  const vectorize = makeVectorizeMock({
    getByIds: vi.fn().mockResolvedValue([{ id: "vec-seed-1", values: new Array(384).fill(0.1) }]),
    query: vi.fn().mockResolvedValue({ matches }),
  });
  return makeTestEnv(undefined, { DB: sqlite.db as any, VECTORIZE: vectorize, OAUTH_KV: kv });
}

async function candidateCount(sqlite: SqliteD1): Promise<number> {
  const row = await sqlite.db.prepare(
    `SELECT COUNT(*) AS n FROM insight_candidates`,
  ).first() as { n: number };
  return row.n;
}

describe("runInsightAccrual()", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    sqlite = makeSqliteD1();
    sqlite.seed({
      id: "seed-1", content: SEED_TEXT, createdAt: NOW,
      tags: ["pricing"], source: "claude-desktop",
      vectorIds: ["vec-seed-1"], importanceScore: 3,
    });
  });

  afterEach(() => sqlite.close());

  it("records a pair that is close in meaning and far apart in time", async () => {
    await runInsightAccrual(makeEnv(sqlite, [match()]), ctx);
    expect(await candidateCount(sqlite)).toBe(1);
  });

  it("normalises the pair so ids are stored in a stable order", async () => {
    await runInsightAccrual(makeEnv(sqlite, [match()]), ctx);
    const row = await sqlite.db.prepare(
      `SELECT a_id, b_id FROM insight_candidates`,
    ).first() as { a_id: string; b_id: string };
    expect(row.a_id < row.b_id).toBe(true);
  });

  it("ignores a neighbour written days rather than months apart", async () => {
    await runInsightAccrual(makeEnv(sqlite, [
      match({ score: 0.95, metadata: { created_at: NOW - 2 * DAY, parentId: "recent-1" } }),
    ]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("ignores a neighbour below the similarity floor", async () => {
    await runInsightAccrual(makeEnv(sqlite, [match({ score: 0.6 })]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("ignores another chunk of the entry itself", async () => {
    await runInsightAccrual(makeEnv(sqlite, [
      match({ id: "vec-seed-1-chunk-2", score: 0.99, metadata: { parentId: "seed-1" } }),
    ]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("ignores a machine-authored neighbour", async () => {
    await runInsightAccrual(makeEnv(sqlite, [
      match({ metadata: { tags: ["synthesized", "pricing"] } }),
    ]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("advances the cursor to the newest seed it examined", async () => {
    const kv = makeMemoryKV();
    await runInsightAccrual(makeEnv(sqlite, [match()], kv), ctx);
    expect(await kv.get(ACCRUAL_CURSOR_KEY)).toBe(String(NOW));
  });

  it("leaves the cursor untouched when Vectorize is unavailable", async () => {
    const kv = makeMemoryKV();
    const vectorize = makeVectorizeMock({
      getByIds: vi.fn().mockRejectedValue(new Error("index unavailable")),
    });
    const env = makeTestEnv(undefined, { DB: sqlite.db as any, VECTORIZE: vectorize, OAUTH_KV: kv });

    await runInsightAccrual(env, ctx);

    expect(await kv.get(ACCRUAL_CURSOR_KEY)).toBeNull();
  });

  it("leaves the cursor untouched when no vector could be fetched", async () => {
    // Not an error — getByIds simply returned nothing. Advancing here would
    // skip these seeds permanently, which is the whole failure the cursor
    // ordering exists to prevent.
    const kv = makeMemoryKV();
    const vectorize = makeVectorizeMock({
      getByIds: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockResolvedValue({ matches: [] }),
    });
    const env = makeTestEnv(undefined, { DB: sqlite.db as any, VECTORIZE: vectorize, OAUTH_KV: kv });

    await runInsightAccrual(env, ctx);

    expect(await kv.get(ACCRUAL_CURSOR_KEY)).toBeNull();
  });

  it("does not throw when the whole pass fails", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); } } as any;
    await expect(
      runInsightAccrual(makeTestEnv(undefined, { DB: broken, OAUTH_KV: makeMemoryKV() }), ctx),
    ).resolves.toBeUndefined();
  });

  it("seeds a candidate from a supersedes edge", async () => {
    sqlite.seed({
      id: "old-decision", createdAt: NOW - 120 * DAY, tags: ["pricing"],
      content: "Decision: price the first tier flat at nine dollars a month for predictability, always.",
    });
    sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('edge-1', 'seed-1', 'old-decision', 'supersedes', 1.0, 'system', '{}', ?, ?)`,
    ).bind(NOW, NOW).run();

    await runInsightAccrual(makeEnv(sqlite, []), ctx);

    const row = await sqlite.db.prepare(
      `SELECT signal FROM insight_candidates`,
    ).first() as { signal: string };
    expect(row.signal).toBe("supersedes");
  });

  it("ignores a supersedes edge between entries written days apart", async () => {
    sqlite.seed({
      id: "yesterday", createdAt: NOW - DAY, tags: ["pricing"],
      content: "Decision: price the first tier flat at nine dollars a month for predictability, always.",
    });
    sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('edge-2', 'seed-1', 'yesterday', 'supersedes', 1.0, 'system', '{}', ?, ?)`,
    ).bind(NOW, NOW).run();

    await runInsightAccrual(makeEnv(sqlite, []), ctx);

    expect(await candidateCount(sqlite)).toBe(0);
  });
});
