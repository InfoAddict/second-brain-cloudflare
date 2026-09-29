import { STANDING_CACHE_MAX_AGE_MS, STANDING_ISOLATE_MEMO_MS, STANDING_KV_PREFIX, VECTORIZE_GET_BY_IDS_BATCH } from "../constants";
import type { Config } from "../config";
import type { Env } from "../env";
import { encodeVector, parseStandingCache, type StandingCacheItem, type StandingCacheV1 } from "./codec";
import { currentValidityAt } from "../memory/validity";

/** The config keys this module needs. Passed explicitly (Task 3: "no config.ts edit is needed yet"); STANDING_MAX and EMBEDDING_DIM are Task 6 additions to DEFAULTS, EMBEDDING_MODEL already exists there today. */
export type StandingCacheConfig = { STANDING_MAX: number; EMBEDDING_DIM: number } & Pick<Config, "EMBEDDING_MODEL">;

// Re-exported so every existing caller and test keeps working unchanged now that Task 6 has
// moved the real definitions into src/constants.ts (a pure rename with no behavior change).
export { STANDING_KV_PREFIX, STANDING_CACHE_MAX_AGE_MS, STANDING_ISOLATE_MEMO_MS };
const KV_WRITE_RETRY_DELAY_MS = 1_100;

// Retry backoff for a row that failed to resolve a vector (budget audit dab677a5: a flat 10-minute retry, with
// no backoff, cost a permanently unresolved memory up to 144 KV writes a day). A row less than 30 minutes old
// retries at 10 minutes, tolerating Vectorize's ordinary async-upsert lag; past that it is probably stuck, not
// lagging, and backs off to 6 hours, bounding a stuck memory's writes to a handful a day.
const RETRY_FAST_MS = 10 * 60 * 1000;
const RETRY_FAST_WINDOW_MS = 30 * 60 * 1000;
const RETRY_SLOW_MS = 6 * 60 * 60 * 1000;
const retryDelayFor = (ageMs: number): number => (ageMs < RETRY_FAST_WINDOW_MS ? RETRY_FAST_MS : RETRY_SLOW_MS);

/** True when two builds would write the identical cache (ignoring `builtAt`, which always advances). */
const sameContent = (a: StandingCacheV1, b: StandingCacheV1 | null): boolean =>
  !!b && a.retryAt === b.retryAt && JSON.stringify(a.items) === JSON.stringify(b.items);

/** "" is the pre-tenancy legacy workspace; KV keys cannot be empty. */
export const standingKvKey = (workspaceId: string): string => `${STANDING_KV_PREFIX}${workspaceId || "-"}`;

const projectsOf = (tags: readonly string[]): string[] =>
  tags.filter(t => t.startsWith("project:")).map(t => t.slice("project:".length).toLowerCase());

interface EntryRow { id: string; tags: string; vector_ids: string; created_at: number }

/**
 * Builds the standing cache for one workspace (Design 2.4). One D1 statement, at most ceil(rows/20) Vectorize
 * `getByIds` calls, and at most one KV write (with one retry on failure), skipped entirely when the result
 * matches what is already stored. Always runs off the response path (the caller's `ctx.waitUntil`), never here.
 *
 * Single-flight per key within this isolate (budget audit dab677a5): concurrent calls for the same workspace
 * share one build, so its D1 and Vectorize cost is paid once, not once per caller. A caller's own `known`
 * vector is used only if it is the one that starts the shared build; a caller who loses the race to an
 * in-flight build simply does not contribute its `known` vector to that round, which P7.4 already tolerates
 * (a miss only delays a new fire, bounded by the next revalidation).
 */
export function buildStandingCache(
  env: Env, cfg: StandingCacheConfig, workspaceId: string,
  known: readonly { id: string; vector: number[] }[] = [],
  opts: { retryDelayMs?: number; now?: number } = {},
): Promise<StandingCacheV1> {
  const key = standingKvKey(workspaceId);
  const existing = inFlightBuilds.get(key);
  if (existing) return existing;
  const promise = buildStandingCacheNow(env, cfg, workspaceId, known, opts)
    .finally(() => { if (inFlightBuilds.get(key) === promise) inFlightBuilds.delete(key); });
  inFlightBuilds.set(key, promise);
  return promise;
}
const inFlightBuilds = new Map<string, Promise<StandingCacheV1>>();

async function buildStandingCacheNow(
  env: Env, cfg: StandingCacheConfig, workspaceId: string,
  known: readonly { id: string; vector: number[] }[],
  opts: { retryDelayMs?: number; now?: number },
): Promise<StandingCacheV1> {
  const now = opts.now ?? Date.now();
  const { results } = await env.DB.prepare(
    // validity: current: a replaced or ended standing instruction must not fire (T-0089.2.1, 5.5)
    `SELECT id, tags, vector_ids, created_at FROM entries
      WHERE workspace_id = ?1
        AND instr(lower(tags), '"standing:active"') > 0
        AND tags NOT LIKE '%"status:deprecated"%'
        AND tags NOT LIKE '%"conflict-held"%'
        AND tags NOT LIKE '%"quarantine:%'
        AND ${currentValidityAt("", "?3")}
      ORDER BY created_at ASC, id ASC
      LIMIT ?2`,
  ).bind(workspaceId, cfg.STANDING_MAX, now).all<EntryRow>();
  const rows = results ?? [];

  const knownFirstChunk = new Map(known.map(k => [k.id, k.vector]));
  const prevRaw = await env.OAUTH_KV.get(standingKvKey(workspaceId), "json");
  const prev = parseStandingCache(prevRaw, { model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM });
  const prevItemById = new Map((prev?.items ?? []).map(i => [i.id, i]));

  const rowChunks = rows.map(row => ({ row, chunkIds: (JSON.parse(row.vector_ids || "[]") as string[]).slice(0, 2) }));

  // Chunks that need a Vectorize fetch: every chunk except a row's first one when a just-written value is known.
  const toFetch: string[] = [];
  for (const { row, chunkIds } of rowChunks) {
    chunkIds.forEach((chunkId, i) => {
      if (i === 0 && knownFirstChunk.has(row.id)) return;
      toFetch.push(chunkId);
    });
  }
  const fetched = new Map<string, ArrayLike<number>>();
  for (let i = 0; i < toFetch.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
    const batch = toFetch.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH);
    if (!batch.length) continue;
    for (const v of await env.VECTORIZE.getByIds(batch)) if (v.values) fetched.set(v.id, v.values);
  }

  const droppedAges: number[] = [];
  const items: StandingCacheItem[] = [];
  for (const { row, chunkIds } of rowChunks) {
    const prevItem = prevItemById.get(row.id);
    const vecs: string[] = [];
    chunkIds.forEach((chunkId, i) => {
      if (i === 0 && knownFirstChunk.has(row.id)) { vecs.push(encodeVector(knownFirstChunk.get(row.id)!)); return; }
      const live = fetched.get(chunkId);
      if (live) { vecs.push(encodeVector(live)); return; }
      // Vectorize upserts are async, so a just-written vector may not be readable yet: fall back to what the
      // previous cache had for this row's same chunk position rather than dropping a vector that still exists.
      const stale = prevItem?.vecs[i];
      if (stale) vecs.push(stale);
    });
    if (!vecs.length) { droppedAges.push(now - row.created_at); continue; }
    items.push({ id: row.id, projects: projectsOf(JSON.parse(row.tags) as string[]), createdAt: row.created_at, vecs });
  }

  const cache: StandingCacheV1 = {
    v: 1, model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM, builtAt: now,
    ...(droppedAges.length && { retryAt: now + Math.min(...droppedAges.map(retryDelayFor)) }),
    items,
  };

  const key = standingKvKey(workspaceId);
  // Tolerates a race with another isolate building the same key (budget audit dab677a5): a fresh read right
  // before writing, separate from `prev` above, catches a result another build already landed while this one
  // was running. Any valid computation is as good as any other (P7.4), so skipping a redundant identical write
  // loses nothing.
  const justWritten = parseStandingCache(await env.OAUTH_KV.get(key, "json"), { model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM });
  // FX3 finding 5: sameContent ignores builtAt by design (a redundant write of identical content
  // is pointless), but skipping unconditionally left the STORED builtAt never advancing once
  // content stabilized — readStandingCaches saw it as permanently stale past STANDING_CACHE_MAX_AGE_MS
  // and rescheduled a rebuild on every read forever, at most 60 seconds apart. Once the stored
  // value has actually gone stale, write anyway, purely to refresh builtAt and reset that clock.
  const storedIsStale = !justWritten || now - justWritten.builtAt > STANDING_CACHE_MAX_AGE_MS;
  if (!sameContent(cache, justWritten) || storedIsStale) {
    const value = JSON.stringify(cache);
    try {
      await env.OAUTH_KV.put(key, value);
    } catch {
      await new Promise(resolve => setTimeout(resolve, opts.retryDelayMs ?? KV_WRITE_RETRY_DELAY_MS));
      try { await env.OAUTH_KV.put(key, value); } catch { /* give up; the next revalidation repairs it (P7.4) */ }
    }
  }
  return cache;
}

// One isolate-level memo of the last KV read per key, and a throttle on how often a stale read may
// schedule a rebuild, both windowed at STANDING_ISOLATE_MEMO_MS (Design 2.5, 2.4 "Revalidation").
const isolateMemo = new Map<string, { cache: StandingCacheV1 | null; readAt: number }>();
const lastScheduledBuild = new Map<string, number>();

/** Test-only: isolate-level state does not reset between test files otherwise. */
export function resetStandingIsolateState(): void {
  isolateMemo.clear();
  lastScheduledBuild.clear();
  inFlightBuilds.clear();
}

function clearStandingMemo(workspaceIds: readonly string[]): void {
  for (const id of workspaceIds) isolateMemo.delete(standingKvKey(id));
}

/**
 * Reads every readable workspace's standing cache with one bulk KV get for whatever the isolate memo does not
 * already cover, then schedules a rebuild (via `ctx.waitUntil`) for any cache that is stale or past its
 * `retryAt`, at most once per workspace per 60 seconds. A missing key means "no standing memories": it is
 * returned as absent (no build scheduled), never rebuilt on a read (Design 2.3).
 */
export async function readStandingCaches(
  env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }, cfg: StandingCacheConfig,
  workspaceIds: readonly string[], now: number = Date.now(),
): Promise<StandingCacheV1[]> {
  const keysNeeded = workspaceIds
    .map(standingKvKey)
    .filter(key => { const m = isolateMemo.get(key); return !m || now - m.readAt > STANDING_ISOLATE_MEMO_MS; });
  if (keysNeeded.length) {
    const raw = await env.OAUTH_KV.get(keysNeeded, "json") as Map<string, unknown>;
    for (const key of keysNeeded) {
      isolateMemo.set(key, { cache: parseStandingCache(raw.get(key) ?? null, { model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM }), readAt: now });
    }
  }

  const out: StandingCacheV1[] = [];
  for (const id of workspaceIds) {
    const cache = isolateMemo.get(standingKvKey(id))?.cache;
    if (!cache) continue;
    out.push(cache);
    const stale = now - cache.builtAt > STANDING_CACHE_MAX_AGE_MS || (cache.retryAt !== undefined && now >= cache.retryAt);
    if (!stale) continue;
    const last = lastScheduledBuild.get(id);
    if (last !== undefined && now - last < STANDING_ISOLATE_MEMO_MS) continue;
    lastScheduledBuild.set(id, now);
    ctx.waitUntil(buildStandingCache(env, cfg, id));
  }
  return out;
}

/**
 * Called only when a write's prior or next tags contain `standing:active` (Design 2.6). Clears the isolate
 * memo so the next read is not served a stale KV value, then schedules a rebuild per workspace (both source
 * and destination for a move), passing along a vector `storeEntry` just computed so the build does not have
 * to wait on Vectorize's async upsert for it.
 */
export function standingTouched(
  env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }, cfg: StandingCacheConfig,
  workspaceIds: readonly string[], known?: readonly { id: string; vector: number[] }[],
): void {
  clearStandingMemo(workspaceIds);
  for (const id of workspaceIds) ctx.waitUntil(buildStandingCache(env, cfg, id, known ?? []));
}
