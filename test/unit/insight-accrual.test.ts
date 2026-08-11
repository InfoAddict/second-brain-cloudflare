import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runInsightAccrual, ACCRUAL_CURSOR_KEY } from "../../src/insight/candidates";
import { scoreCandidate, type ScorableEntry } from "../../src/insight/score";
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
  const { metadata: metaOver, ...rest } = over;
  return {
    id: "vec-old-1",
    score: 0.87,
    ...rest,
    metadata: {
      parentId: "old-1",
      created_at: NOW - 90 * DAY,
      tags: ["pricing"],
      content: OLD_TEXT,
      source: "claude-desktop",
      ...(metaOver ?? {}),
    },
  };
}

/**
 * A real D1 row for the neighbour a `match()` points at. Since accrual now
 * hydrates neighbour data from D1 rather than trusting vector metadata, any
 * test whose neighbour is meant to actually qualify needs a live row here —
 * metadata alone is no longer enough to make one eligible.
 */
function seedNeighbour(sqlite: SqliteD1, overrides: Partial<{
  id: string; content: string; createdAt: number; tags: string[]; source: string; importanceScore: number;
}> = {}) {
  sqlite.seed({
    id: "old-1",
    content: OLD_TEXT,
    createdAt: NOW - 90 * DAY,
    tags: ["pricing"],
    source: "claude-desktop",
    importanceScore: 0,
    ...overrides,
  });
}

function makeEnv(sqlite: SqliteD1, matches: any[], kv = makeMemoryKV()): Env {
  const vectorize = makeVectorizeMock({
    // Echoes back whatever ids were requested. A fixed single-id response
    // only ever coincidentally matched single-seed tests; any scenario with
    // more than one seed needs each seed's own head vector to resolve.
    getByIds: vi.fn().mockImplementation(async (ids: string[]) =>
      ids.map(id => ({ id, values: new Array(384).fill(0.1) }))),
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
    seedNeighbour(sqlite);
    await runInsightAccrual(makeEnv(sqlite, [match()]), ctx);
    expect(await candidateCount(sqlite)).toBe(1);
  });

  it("normalises the pair so ids are stored in a stable order", async () => {
    seedNeighbour(sqlite);
    await runInsightAccrual(makeEnv(sqlite, [match()]), ctx);
    const row = await sqlite.db.prepare(
      `SELECT a_id, b_id FROM insight_candidates`,
    ).first() as { a_id: string; b_id: string };
    expect(row.a_id < row.b_id).toBe(true);
  });

  it("ignores a neighbour written days rather than months apart", async () => {
    seedNeighbour(sqlite, { id: "recent-1", createdAt: NOW - 2 * DAY });
    await runInsightAccrual(makeEnv(sqlite, [
      match({ score: 0.95, metadata: { parentId: "recent-1" } }),
    ]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("ignores a neighbour below the similarity floor", async () => {
    // No D1 row needed: the score check is a cheap pre-filter on Vectorize's
    // own similarity score, decided before any neighbour is ever hydrated.
    await runInsightAccrual(makeEnv(sqlite, [match({ score: 0.6 })]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("ignores another chunk of the entry itself, and never pays to hydrate it", async () => {
    await runInsightAccrual(makeEnv(sqlite, [
      match({ id: "vec-seed-1-chunk-2", score: 0.99, metadata: { parentId: "seed-1" } }),
    ]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
    // Once neighbour dates come from D1, a same-parent chunk always hydrates
    // to the seed's own row (same id, same created_at), so the gap floor
    // would reject it too — but only after paying for a needless D1 lookup.
    // The guard's remaining job is exactly that: no hydration statement
    // should be issued for a batch that is only self-matches.
    const hydrationCalls = sqlite.issued.filter(sql => sql.includes("WHERE id IN"));
    expect(hydrationCalls.length).toBe(0);
  });

  it("ignores a machine-authored neighbour", async () => {
    seedNeighbour(sqlite, { tags: ["synthesized", "pricing"] });
    await runInsightAccrual(makeEnv(sqlite, [match()]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("uses D1's created_at rather than stale vector metadata for the gap check", async () => {
    // The neighbour is genuinely four months old in D1...
    seedNeighbour(sqlite, { createdAt: NOW - 120 * DAY });
    // ...but its vector's metadata — stamped whenever it was last embedded,
    // e.g. an append — claims it is two days old, which would fail the
    // 30-day floor if trusted.
    await runInsightAccrual(makeEnv(sqlite, [
      match({ metadata: { created_at: NOW - 2 * DAY } }),
    ]), ctx);
    expect(await candidateCount(sqlite)).toBe(1);
  });

  it("uses the neighbour's D1 importance for the importance boost, not zero", async () => {
    seedNeighbour(sqlite, { importanceScore: 5 });
    await runInsightAccrual(makeEnv(sqlite, [match()]), ctx);

    const row = await sqlite.db.prepare(`SELECT score FROM insight_candidates`).first() as { score: number };
    // seed-1 has importanceScore 3 (beforeEach); old-1 has 5 here.
    // importanceBoost uses max(a.importance, b.importance) — 5, not 3 — which
    // only happens if the neighbour's real D1 importance reaches
    // scoreCandidate rather than the hardcoded 0 it used to get.
    const seedScorable: ScorableEntry = { id: "seed-1", tags: ["pricing"], importance: 3, createdAt: NOW };
    const neighbourScorable: ScorableEntry = { id: "old-1", tags: ["pricing"], importance: 5, createdAt: NOW - 90 * DAY };
    const expected = scoreCandidate(seedScorable, neighbourScorable, 0.87);
    expect(row.score).toBeCloseTo(expected, 10);
  });

  it("advances the cursor to the newest seed it examined", async () => {
    const kv = makeMemoryKV();
    seedNeighbour(sqlite);
    await runInsightAccrual(makeEnv(sqlite, [match()], kv), ctx);
    const cursor = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(cursor).toEqual({ createdAt: NOW, id: "seed-1" });
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

  it("advances the cursor past a window with no eligible seed, so rejected rows are not re-read forever", async () => {
    const kv = makeMemoryKV();
    // Push the cursor past the default seed-1 so this run's window contains
    // only the row below.
    await kv.put(ACCRUAL_CURSOR_KEY, JSON.stringify({ createdAt: NOW, id: "seed-1" }));
    sqlite.seed({
      id: "too-short", content: "short.", createdAt: NOW + DAY,
      tags: ["pricing"], source: "claude-desktop", vectorIds: ["vec-too-short"], importanceScore: 0,
    });

    await runInsightAccrual(makeEnv(sqlite, [], kv), ctx);

    // "too-short" was examined and correctly rejected (fails the content
    // floor) — not skipped. Holding the cursor here would re-read it, and
    // only it, forever.
    const cursor = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(cursor).toEqual({ createdAt: NOW + DAY, id: "too-short" });
  });

  it("keeps a same-timestamp tie from being lost across the batch boundary", async () => {
    const kv = makeMemoryKV();
    const tieIds = Array.from({ length: 26 }, (_, i) => `tie-${String(i).padStart(2, "0")}`);
    for (const id of tieIds) {
      sqlite.seed({
        id, content: SEED_TEXT, createdAt: NOW + DAY,
        tags: ["pricing"], source: "claude-desktop", vectorIds: [`vec-${id}`], importanceScore: 0,
      });
    }

    await runInsightAccrual(makeEnv(sqlite, [], kv), ctx);
    const afterFirst = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(afterFirst.createdAt).toBe(NOW + DAY);
    // A single-column `created_at > cursor` comparison would now exclude
    // every remaining tied row forever: none of their timestamps are greater
    // than the cursor's, only their ids are.
    expect(tieIds).toContain(afterFirst.id);

    await runInsightAccrual(makeEnv(sqlite, [], kv), ctx);
    const afterSecond = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(tieIds.indexOf(afterSecond.id)).toBeGreaterThan(tieIds.indexOf(afterFirst.id));
  });

  it("excludes entries at or before a previously-set cursor", async () => {
    const kv = makeMemoryKV();
    sqlite.seed({
      id: "seed-2", content: SEED_TEXT, createdAt: NOW + DAY,
      tags: ["pricing"], source: "claude-desktop", vectorIds: ["vec-seed-2"], importanceScore: 0,
    });
    // Sitting exactly on seed-1's own position.
    await kv.put(ACCRUAL_CURSOR_KEY, JSON.stringify({ createdAt: NOW, id: "seed-1" }));

    const env = makeEnv(sqlite, [], kv);
    await runInsightAccrual(env, ctx);

    // If seed-1 were wrongly re-included (e.g. `>` loosened to `>=`), it
    // would reach Vectorize a second time.
    expect(((env.VECTORIZE as any).query as any).mock.calls.length).toBe(1);
    const cursorAfter = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(cursorAfter.id).toBe("seed-2");
  });

  it("writes the cursor as the newest examined seed's own timestamp, not the wall clock", async () => {
    sqlite.close();
    sqlite = makeSqliteD1();
    const earlier = NOW - 2 * DAY;
    const later = NOW - DAY;
    sqlite.seed({
      id: "seed-a", content: SEED_TEXT, createdAt: earlier,
      tags: ["pricing"], source: "claude-desktop", vectorIds: ["vec-seed-1"], importanceScore: 0,
    });
    sqlite.seed({
      id: "seed-b", content: SEED_TEXT, createdAt: later,
      tags: ["pricing"], source: "claude-desktop", vectorIds: ["vec-seed-2"], importanceScore: 0,
    });

    const kv = makeMemoryKV();
    await runInsightAccrual(makeEnv(sqlite, [], kv), ctx);

    const cursorAfter = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(cursorAfter.createdAt).toBe(later);
    expect(cursorAfter.createdAt).not.toBe(NOW);
    expect(cursorAfter.id).toBe("seed-b");
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
