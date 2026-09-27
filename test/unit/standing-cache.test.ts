import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  buildStandingCache, readStandingCaches, resetStandingIsolateState, standingKvKey, standingTouched,
  STANDING_CACHE_MAX_AGE_MS, STANDING_ISOLATE_MEMO_MS, type StandingCacheConfig,
} from "../../src/standing/cache";
import { decodeVector, encodeVector, type StandingCacheV1 } from "../../src/standing/codec";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";

const cfg: StandingCacheConfig = { STANDING_MAX: 3, EMBEDDING_MODEL: "m", EMBEDDING_DIM: 2 };

function insertEntry(sqlite: SqliteD1, opts: { id: string; workspaceId?: string; tags?: string[]; vectorIds?: string[]; createdAt?: number }): void {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES (?, 'memory', ?, 'api', ?, ?, ?)`,
  ).bind(
    opts.id, JSON.stringify(opts.tags ?? ["standing:active"]), opts.createdAt ?? 1,
    JSON.stringify(opts.vectorIds ?? [opts.id]), opts.workspaceId ?? "ws-a",
  ).run();
}

function makeStandingKV(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const puts: { key: string; value: unknown }[] = [];
  let failNextPuts = 0;
  const kv = {
    get: vi.fn(async (keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        const m = new Map<string, unknown>();
        for (const k of keyOrKeys) m.set(k, store.get(k) ?? null);
        return m;
      }
      return store.get(keyOrKeys) ?? null;
    }),
    put: vi.fn(async (key: string, value: string) => {
      if (failNextPuts > 0) { failNextPuts--; throw new Error("429"); }
      const parsed = JSON.parse(value);
      store.set(key, parsed);
      puts.push({ key, value: parsed });
    }),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
  } as unknown as KVNamespace;
  return { kv, store, puts, failNextPuts: (n: number) => { failNextPuts = n; } };
}

function makeStandingVectorize(vectors: Record<string, number[]>) {
  const calls: string[][] = [];
  const vectorize = {
    getByIds: vi.fn(async (ids: string[]) => {
      calls.push(ids);
      return ids.filter(id => vectors[id]).map(id => ({ id, values: vectors[id] }));
    }),
  } as unknown as VectorizeIndex;
  return { vectorize, calls };
}

function envFor(sqlite: SqliteD1, vectorize: VectorizeIndex, kv: KVNamespace): Env {
  return makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, VECTORIZE: vectorize, OAUTH_KV: kv });
}

const vecOf = (item: StandingCacheV1["items"][number] | undefined, i = 0) => (item ? Array.from(decodeVector(item.vecs[i])) : undefined);

describe("buildStandingCache", () => {
  let sqlite: SqliteD1;
  beforeEach(() => { sqlite = makeSqliteD1(); resetStandingIsolateState(); });

  it("keeps the oldest STANDING_MAX, dropping newer over-cap rows", async () => {
    for (let i = 0; i < 5; i++) insertEntry(sqlite, { id: `m${i}`, createdAt: i, vectorIds: [`m${i}`] });
    const { vectorize } = makeStandingVectorize(Object.fromEntries([0, 1, 2, 3, 4].map(i => [`m${i}`, [i, i]])));
    const { kv } = makeStandingKV();
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a");
    expect(cache.items.map(i => i.id)).toEqual(["m0", "m1", "m2"]);
  });

  it("excludes deprecated, conflict-held and quarantine rows", async () => {
    insertEntry(sqlite, { id: "keep", tags: ["standing:active"], createdAt: 1 });
    insertEntry(sqlite, { id: "deprecated", tags: ["standing:active", "status:deprecated"], createdAt: 2 });
    insertEntry(sqlite, { id: "held", tags: ["standing:active", "conflict-held"], createdAt: 3 });
    insertEntry(sqlite, { id: "quarantined", tags: ["standing:active", "quarantine:hidden-instruction"], createdAt: 4 });
    const { vectorize } = makeStandingVectorize({ keep: [1, 1], deprecated: [1, 1], held: [1, 1], quarantined: [1, 1] });
    const { kv } = makeStandingKV();
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a");
    expect(cache.items.map(i => i.id)).toEqual(["keep"]);
  });

  it("uses known vectors for just-written rows instead of fetching them", async () => {
    insertEntry(sqlite, { id: "fresh", createdAt: 1, vectorIds: ["fresh"] });
    const { vectorize, calls } = makeStandingVectorize({}); // Vectorize has nothing yet (async upsert not visible)
    const { kv } = makeStandingKV();
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a", [{ id: "fresh", vector: [3, 4] }]);
    expect(cache.items).toHaveLength(1);
    expect(vecOf(cache.items[0])).toEqual([3, 4]);
    expect(calls).toHaveLength(0); // never asked Vectorize for the chunk it already has
  });

  it("keeps a previous vector when getByIds misses and sets retryAt", async () => {
    insertEntry(sqlite, { id: "stale-fetch", createdAt: 1, vectorIds: ["stale-fetch"] });
    const prev: StandingCacheV1 = {
      v: 1, model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM, builtAt: 0,
      items: [{ id: "stale-fetch", projects: [], createdAt: 1, vecs: [encodeVector([5, 6])] }],
    };
    const { vectorize } = makeStandingVectorize({}); // this build's getByIds misses it
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: prev });
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a", [], { now: 1000 });
    expect(cache.items).toHaveLength(1);
    expect(vecOf(cache.items[0])).toEqual([5, 6]);
    expect(cache.retryAt).toBeUndefined(); // the row was recovered from the previous cache, so nothing to retry
  });

  it("drops a row and sets retryAt when neither a known vector nor a fetch nor a previous cache has it", async () => {
    insertEntry(sqlite, { id: "not-indexed-yet", createdAt: 1, vectorIds: ["not-indexed-yet"] });
    const { vectorize } = makeStandingVectorize({});
    const { kv } = makeStandingKV();
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a", [], { now: 1000 });
    expect(cache.items).toHaveLength(0);
    expect(cache.retryAt).toBe(1000 + 10 * 60 * 1000);
  });

  it("batches getByIds at VECTORIZE_GET_BY_IDS_BATCH (20)", async () => {
    for (let i = 0; i < 25; i++) insertEntry(sqlite, { id: `m${i}`, createdAt: i, vectorIds: [`m${i}`] });
    const { vectorize, calls } = makeStandingVectorize(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`m${i}`, [i, i]])));
    const { kv } = makeStandingKV();
    await buildStandingCache(envFor(sqlite, vectorize, kv), { ...cfg, STANDING_MAX: 25 }, "ws-a");
    expect(calls.map(c => c.length)).toEqual([20, 5]);
  });

  it("never reads another workspace's rows", async () => {
    insertEntry(sqlite, { id: "mine", workspaceId: "ws-a", createdAt: 1, vectorIds: ["mine"] });
    insertEntry(sqlite, { id: "theirs", workspaceId: "ws-b", createdAt: 2, vectorIds: ["theirs"] });
    const { vectorize } = makeStandingVectorize({ mine: [1, 1], theirs: [1, 1] });
    const { kv } = makeStandingKV();
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a");
    expect(cache.items.map(i => i.id)).toEqual(["mine"]);
  });

  it("retries once after a put failure and then gives up without throwing", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize } = makeStandingVectorize({ m: [1, 1] });
    const { kv, puts } = makeStandingKV();
    kv.put = vi.fn().mockRejectedValue(new Error("429"));
    await expect(buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a", [], { retryDelayMs: 0 })).resolves.toBeDefined();
    expect(vi.mocked(kv.put).mock.calls).toHaveLength(2);
  });

  it("writes builtAt even when items are unchanged from the previous cache", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize } = makeStandingVectorize({ m: [1, 1] });
    const { kv, puts } = makeStandingKV();
    await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a", [], { now: 1000 });
    await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a", [], { now: 2000 });
    expect(puts).toHaveLength(2);
    expect((puts[0].value as StandingCacheV1).builtAt).toBe(1000);
    expect((puts[1].value as StandingCacheV1).builtAt).toBe(2000);
    expect((puts[0].value as StandingCacheV1).items).toEqual((puts[1].value as StandingCacheV1).items);
  });
});

describe("readStandingCaches", () => {
  let sqlite: SqliteD1;
  const waitUntil = vi.fn((p: Promise<unknown>) => { p.catch(() => {}); });
  beforeEach(() => { sqlite = makeSqliteD1(); resetStandingIsolateState(); waitUntil.mockClear(); });

  const cacheAt = (builtAt: number, retryAt?: number): StandingCacheV1 =>
    ({ v: 1, model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM, builtAt, ...(retryAt !== undefined && { retryAt }), items: [] });

  it("bulk-reads all workspace keys in one call", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(1000), [standingKvKey("ws-b")]: cacheAt(1000) });
    const { vectorize } = makeStandingVectorize({});
    const ctx = { waitUntil };
    await readStandingCaches(envFor(sqlite, vectorize, kv), ctx, cfg, ["ws-a", "ws-b"], 1000);
    expect(vi.mocked(kv.get).mock.calls).toHaveLength(1);
    expect(vi.mocked(kv.get).mock.calls[0][0]).toEqual([standingKvKey("ws-a"), standingKvKey("ws-b")]);
  });

  it("missing key means empty and schedules nothing", async () => {
    const { kv } = makeStandingKV();
    const { vectorize } = makeStandingVectorize({});
    const out = await readStandingCaches(envFor(sqlite, vectorize, kv), { waitUntil }, cfg, ["ws-a"], 1000);
    expect(out).toEqual([]);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("memoizes a read for 60 seconds; standingTouched clears it", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(1000) });
    const { vectorize } = makeStandingVectorize({});
    const env = envFor(sqlite, vectorize, kv);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], 1000);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], 1000 + STANDING_ISOLATE_MEMO_MS - 1);
    expect(vi.mocked(kv.get).mock.calls).toHaveLength(1); // still memoized

    standingTouched(env, { waitUntil }, cfg, ["ws-a"]);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], 1000 + STANDING_ISOLATE_MEMO_MS - 1);
    // standingTouched cleared the memo, so this read goes to KV again despite being inside the 60s window.
    expect(vi.mocked(kv.get).mock.calls).toHaveLength(2);
  });

  it("re-reads once the memo window has passed", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(1000) });
    const { vectorize } = makeStandingVectorize({});
    const env = envFor(sqlite, vectorize, kv);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], 1000);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], 1000 + STANDING_ISOLATE_MEMO_MS + 1);
    expect(vi.mocked(kv.get).mock.calls).toHaveLength(2);
  });

  it("schedules a rebuild for a stale builtAt, at most once per workspace per 60 seconds", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(0) });
    const { vectorize } = makeStandingVectorize({});
    const env = envFor(sqlite, vectorize, kv);
    const now = STANDING_CACHE_MAX_AGE_MS + 1;
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], now);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    // A second stale read moments later, inside the throttle window, schedules nothing more.
    resetKvGetOnly(kv);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], now + 1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("schedules a rebuild for a passed retryAt", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(1000, 2000) });
    const { vectorize } = makeStandingVectorize({});
    await readStandingCaches(envFor(sqlite, vectorize, kv), { waitUntil }, cfg, ["ws-a"], 2500);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a rebuild for a fresh cache with no pending retry", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(1000) });
    const { vectorize } = makeStandingVectorize({});
    await readStandingCaches(envFor(sqlite, vectorize, kv), { waitUntil }, cfg, ["ws-a"], 1000 + 1000);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe("standingTouched", () => {
  let sqlite: SqliteD1;
  beforeEach(() => { sqlite = makeSqliteD1(); resetStandingIsolateState(); });

  it("schedules a build per workspace, passing known vectors through", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize } = makeStandingVectorize({}); // Vectorize has nothing; only "known" resolves it
    const { kv, puts } = makeStandingKV();
    const scheduled: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => scheduled.push(p) };
    standingTouched(envFor(sqlite, vectorize, kv), ctx, cfg, ["ws-a"], [{ id: "m", vector: [7, 8] }]);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(puts).toHaveLength(1);
    const cache = puts[0].value as StandingCacheV1;
    expect(vecOf(cache.items[0])).toEqual([7, 8]);
  });
});

function resetKvGetOnly(kv: KVNamespace): void {
  vi.mocked(kv.get).mockClear();
}
