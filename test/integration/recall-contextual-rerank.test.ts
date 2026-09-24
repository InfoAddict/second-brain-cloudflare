/**
 * Contextual embeddings ON with the reranker ON: a note is indexed as several chunk vectors, and the deep fill asks
 * for ids only (topK 100). The reranker must still see parents, never chunks: one candidate per note, at most
 * RERANK_MAX_CANDIDATES of them, with the graph slots and the topK prefix property intact.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { RECALL_MAX_TOP_K, RERANK_MAX_CANDIDATES, RERANK_MODEL, RERANK_READY_KV_KEY } from "../../src/constants";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import { resetRerankReadyMemo } from "../../src/recall/model-reranker";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { mulberry32 } from "../eval/stats";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const CHUNKS = 3;

describe("contextual embeddings with the reranker", () => {
  const open: SqliteD1[] = [];
  afterEach(() => { open.splice(0).forEach(s => s.close()); resetRerankReadyMemo(); });

  async function corpus(seed: number) {
    resetDatabaseInit();
    resetRerankReadyMemo();
    const rand = mulberry32(seed);
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    const DB = new Proxy(sqlite.db as object as Record<string, unknown>, {
      get: (target, key) => key === "prepare"
        ? (sql: string) => sql.includes("SET recall_count = recall_count + 1") ? { bind: () => ({ run: async () => ({}) }) } : (target.prepare as (s: string) => unknown)(sql)
        : typeof target[key as string] === "function" ? (target[key as string] as (...a: unknown[]) => unknown).bind(target) : target[key as string],
    });
    const kv = makeMemoryKV();
    await kv.put(RERANK_READY_KV_KEY, "1");
    const batches: { texts: string[] }[] = [];
    const ai = { run: vi.fn(async (model: string, input: any) => {
      if (model === RERANK_MODEL) {
        batches.push({ texts: input.contexts.map((c: { text: string }) => c.text) });
        return { response: input.contexts.map((_c: unknown, id: number) => ({ id, score: ((id * 7) % 11) - 5 })) };
      }
      return { data: [new Array(384).fill(0.1)] };
    }) } as unknown as Ai;
    const env = makeTestEnv(undefined, { DB: DB as unknown as Env["DB"], OAUTH_KV: kv, AI: ai }) as Env;
    await initializeDatabase(env);
    const n = 40;
    for (let i = 0; i < n; i++) {
      sqlite.seed({ id: `m${i}`, content: `topic note number ${i} about planning`, createdAt: 1000 + Math.floor(rand() * 500), tags: ["work"] });
    }
    for (let k = 0; k < 14; k++) {
      sqlite.seed({ id: `link${k}`, content: `why the planning changed: rationale ${k}`, createdAt: 1600 + k, tags: ["work"] });
      const from = Math.floor(rand() * n);
      await sqlite.db.prepare(`INSERT OR IGNORE INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at) VALUES (?, ?, ?, 'decided', 1, 'explicit', '{}', 1, 1)`)
        .bind(`edge-${k}`, `m${from}`, `link${k}`).run();
    }
    // Every note is CHUNKS adjacent vectors, so the top of any list is the same few notes repeated.
    const order = Array.from({ length: n }, (_, i) => ({ i, r: rand() })).sort((x, y) => y.r - x.r);
    const index = order.flatMap((x, k) => Array.from({ length: CHUNKS }, (_, c) => ({
      id: `m${x.i}-chunk-${c}`, score: 0.98 - (k * CHUNKS + c) * 0.0015, values: Array.from({ length: 6 }, () => rand() - 0.5), metadata: { parentId: `m${x.i}`, isUpdate: false },
    })));
    const queries: { topK: number; idsOnly: boolean }[] = [];
    const query = vi.fn(async (_v: unknown, opts: { topK?: number; returnMetadata?: string } = {}) => {
      const idsOnly = opts.returnMetadata === "none";
      queries.push({ topK: opts.topK ?? 10, idsOnly });
      // As the index does: 50 with values or metadata, 100 without, and no metadata when none is asked for.
      const matches = index.slice(0, Math.min(opts.topK ?? 10, idsOnly ? 100 : 50));
      return { matches: idsOnly ? matches.map(({ id, score }) => ({ id, score })) : matches };
    });
    (env as any).VECTORIZE = makeVectorizeMock({ query: query as never });
    return { env, batches, queries };
  }

  const run = async (env: Env, topK: number, hops: number, contextual: "on" | "off" = "on") => {
    const diagnostics: RecallDiagnostics = {};
    const cfg = Object.freeze({ ...DEFAULTS, RERANK_MODE: "on" as const, CONTEXTUAL_EMBEDDINGS: contextual });
    const res = await recallEntries({ query: "why did the topic note planning change", topK, hops, synthesize: false }, env, ctx, cfg, { diagnostics });
    return { ids: res.matches.map(m => m.id), diagnostics };
  };

  it("scores at most RERANK_MAX_CANDIDATES distinct notes, never a chunk twice", async () => {
    for (const seed of [3, 4, 5]) {
      const { env, batches } = await corpus(seed);
      for (const hops of [0, 1]) {
        batches.length = 0;
        const { diagnostics } = await run(env, RECALL_MAX_TOP_K, hops);
        expect(diagnostics.rerankRoute, `seed ${seed}, hops ${hops}`).toBe("applied");
        expect(batches).toHaveLength(1);
        const texts = batches[0].texts;
        expect(texts.length).toBeLessThanOrEqual(RERANK_MAX_CANDIDATES);
        expect(new Set(texts).size, "a note reached the reranker as more than one candidate").toBe(texts.length);
      }
    }
  });

  it("asks for the ids-only deep list, and every note in the result is listed once", async () => {
    const { env, queries } = await corpus(6);
    const { ids } = await run(env, RECALL_MAX_TOP_K, 1);
    expect(queries.some(q => q.idsOnly && q.topK === 100)).toBe(true);
    expect(ids).toHaveLength(RECALL_MAX_TOP_K);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the graph slots where they sit without contextual embeddings", async () => {
    for (const seed of [3, 4]) {
      const { env } = await corpus(seed);
      const slots = async (contextual: "on" | "off") => (await run(env, RECALL_MAX_TOP_K, 1, contextual)).ids
        .map((id, rank) => ({ id, rank })).filter(x => x.id.startsWith("link")).map(x => x.rank);
      const on = await slots("on");
      expect(on.length, "the graph must surface linked notes for this to mean anything").toBeGreaterThan(0);
      expect(on).toEqual(await slots("off"));
    }
  });

  it("keeps the topK prefix property, with and without hops", async () => {
    for (const seed of [3, 4]) {
      const { env } = await corpus(seed);
      for (const hops of [0, 1, 2]) {
        const lists: string[][] = [];
        for (let k = 1; k <= RECALL_MAX_TOP_K; k++) lists.push((await run(env, k, hops)).ids);
        for (let a = 0; a < lists.length; a++) for (let b = a + 1; b < lists.length; b++) {
          expect(lists[a], `seed ${seed}, hops ${hops}, topK ${a + 1} vs ${b + 1}`).toEqual(lists[b].slice(0, lists[a].length));
        }
      }
    }
  }, 240_000);
});
