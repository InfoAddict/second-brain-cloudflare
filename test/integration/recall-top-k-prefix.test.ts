/**
 * T-0081 — a larger topK only appends: the results for topK k are the first k of the results for any larger topK.
 * The candidate pool, the diversity pass and the graph slots used to scale with topK, so the head reshuffled.
 * Driven through recallEntries with a Vectorize mock that honours topK, as the real index does.
 */
import { describe, expect, it, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { RECALL_DEEP_POOL_SIZE, RECALL_MAX_TOP_K, RECALL_POOL_SIZE } from "../../src/constants";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

/** `parents` memories, each indexed as two chunks, best-scoring first. */
function setup(parents: number) {
  const db = new D1Mock();
  for (let i = 0; i < parents; i++) {
    db.entries.push({ id: `e${i}`, content: `topic note ${i}`, tags: "[]", source: "api", created_at: 1000 + i, vector_ids: "[]", recall_count: 0, importance_score: 0 });
  }
  const index = Array.from({ length: parents * 2 }, (_, i) => ({ id: `v${i}`, score: 0.95 - i * 0.005, metadata: { parentId: `e${Math.floor(i / 2)}`, isUpdate: false } }));
  const query = vi.fn(async (_v: unknown, opts: { topK?: number } = {}) => ({ matches: index.slice(0, opts.topK ?? 10) }));
  const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: query as never }) });
  // No keyword rows: the dense arm alone decides, so the candidate count is the parent count.
  const prepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => sql.includes("WHERE content LIKE") && sql.includes("ORDER BY created_at DESC LIMIT")
    ? { bind: () => ({ all: async () => ({ results: [] }) }) }
    : prepare(sql);
  const recall = async (topK: number, hops = 0) => (await recallEntries({ query: "topic note", topK, hops, synthesize: false }, env, ctx)).matches.map(m => m.id);
  return { recall, query };
}

describe("recall topK never reorders the head (T-0081)", () => {
  it("returns the first k of the topK-20 list for every k, with and without hops", async () => {
    for (const hops of [0, 1]) {
      const { recall } = setup(30);
      const full = await recall(RECALL_MAX_TOP_K, hops);
      expect(full).toHaveLength(RECALL_MAX_TOP_K);
      for (let k = 1; k < RECALL_MAX_TOP_K; k++) expect(await recall(k, hops), `topK ${k}, hops ${hops}`).toEqual(full.slice(0, k));
    }
  });

  it("draws from a deeper dense list only when the diversified one is shorter than topK, and only appends", async () => {
    // 15 chunks fill the pool but are 8 memories; 30 chunks are 15.
    const { recall, query } = setup(25);
    const head = await recall(5);
    expect(query.mock.calls.map(c => (c[1] as { topK: number }).topK)).toEqual([RECALL_POOL_SIZE]);
    query.mockClear();
    const deep = await recall(12);
    expect(query.mock.calls.map(c => (c[1] as { topK: number }).topK)).toEqual([RECALL_POOL_SIZE, RECALL_DEEP_POOL_SIZE]);
    expect(deep).toHaveLength(12);
    expect(new Set(deep).size).toBe(12);
    expect(deep.slice(0, 5)).toEqual(head);
  });

  it("does not ask for the deeper list when the index has nothing more to give", async () => {
    const { recall, query } = setup(3); // 6 chunks: the pool never fills
    expect(await recall(RECALL_MAX_TOP_K)).toHaveLength(3);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
