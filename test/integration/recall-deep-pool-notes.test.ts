/**
 * T-0042 x T-0081: the deep dense fill is sized in distinct notes. Contextual chunking makes one long note up to seven
 * vectors, so a fill of 50 vectors can be a handful of notes. With contextual embeddings on the fill asks for ids only,
 * which Vectorize returns up to 100 of, and reads the note from each id; with them off nothing about the fill changes.
 */
import { describe, expect, it, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { DEFAULTS, type Config } from "../../src/config";
import { RECALL_DEEP_IDS_POOL_SIZE, RECALL_DEEP_POOL_SIZE, RECALL_POOL_SIZE } from "../../src/constants";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { mulberry32 } from "../eval/stats";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const on: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "on" };
const off: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "off" };
const PER_NOTE = 7;

/** `notes` long notes, each seven chunks, best-scoring notes first; the mock honours topK and returnMetadata like the index. */
function setup(notes: number, topScore = 0.95) {
  const db = new D1Mock();
  for (let i = 0; i < notes; i++) db.entries.push({ id: `e${i}`, content: `topic note ${i}`, tags: "[]", source: "api", created_at: 1000 + i, vector_ids: "[]", recall_count: 0, importance_score: 0 });
  const rand = mulberry32(notes);
  const index = Array.from({ length: notes * PER_NOTE }, (_, i) => ({
    id: `e${Math.floor(i / PER_NOTE)}-chunk-${i % PER_NOTE}`, score: topScore - i * 0.001, values: Array.from({ length: 6 }, () => rand() - 0.5), metadata: { parentId: `e${Math.floor(i / PER_NOTE)}`, isUpdate: false },
  }));
  const query = vi.fn(async (_v: unknown, opts: { topK?: number; returnMetadata?: string; returnValues?: boolean } = {}) => ({
    matches: index.slice(0, opts.topK ?? 10).map(m => (opts.returnMetadata === "none" || opts.returnMetadata === undefined ? { id: m.id, score: m.score } : m)),
  }));
  const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: query as never }) });
  const prepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => sql.includes("WHERE content LIKE") && sql.includes("ORDER BY created_at DESC LIMIT")
    ? { bind: () => ({ all: async () => ({ results: [] }) }) }
    : prepare(sql);
  const recall = async (topK: number, cfg: Config) => (await recallEntries({ query: "topic note", topK, hops: 0, synthesize: false }, env, ctx, cfg)).matches.map(m => m.id);
  return { recall, query };
}

describe("deep dense fill sized in distinct notes", () => {
  it("with contextual off, a fill of 50 vectors is what it always was: a shorter list when notes are seven vectors each", async () => {
    const { recall, query } = setup(30);
    const got = await recall(20, off);
    expect(query.mock.calls.map(c => (c[1] as { topK: number }).topK)).toEqual([RECALL_POOL_SIZE, RECALL_DEEP_POOL_SIZE]);
    expect((query.mock.calls[1][1] as { returnMetadata?: string }).returnMetadata).toBe("all");
    expect(got.length).toBeLessThan(20);
  });

  it("with contextual on, the fill asks for ids only, up to 100, and yields about twice the distinct notes", async () => {
    const { recall, query } = setup(30);
    const got = await recall(20, on);
    expect(query.mock.calls.map(c => (c[1] as { topK: number }).topK)).toEqual([RECALL_POOL_SIZE, RECALL_DEEP_IDS_POOL_SIZE]);
    expect((query.mock.calls[1][1] as { returnMetadata?: string }).returnMetadata).toBe("none");
    // 100 vectors at seven per note reach 15 distinct notes; 50 reach 8.
    expect(got).toHaveLength(Math.ceil(RECALL_DEEP_IDS_POOL_SIZE / PER_NOTE));
    expect(new Set(got).size).toBe(got.length);
    expect(got.length).toBeGreaterThan((await setup(30).recall(20, off)).length);
  });

  it("the head is the same as with off: only the fill differs", async () => {
    const off5 = await setup(30).recall(5, off);
    const on5 = await setup(30).recall(5, on);
    expect(on5).toEqual(off5);
    const shortOff = await setup(30).recall(8, off);
    const shortOn = await setup(30).recall(8, on);
    expect(shortOn.slice(0, shortOff.length)).toEqual(shortOff);
  });

  it("reuses the deep list the widening query already fetched, as off does, instead of a third query", async () => {
    // a weak best match (0.5 < the widen threshold) widens the primary query to 50 vectors: that deep list is in hand
    for (const cfg of [off, on]) {
      const { recall, query } = setup(30, 0.5);
      const got = await recall(12, cfg);
      expect(query.mock.calls.map(c => (c[1] as { topK: number }).topK), cfg.CONTEXTUAL_EMBEDDINGS).toEqual([RECALL_POOL_SIZE, RECALL_DEEP_POOL_SIZE]);
      expect(got.length).toBeGreaterThan(0);
    }
    const a = await setup(30, 0.5).recall(12, off);
    const b = await setup(30, 0.5).recall(12, on);
    expect(b).toEqual(a);
  });

  it("does not ask for the deeper list when the pool never fills", async () => {
    const { recall, query } = setup(2);
    await recall(20, on);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
