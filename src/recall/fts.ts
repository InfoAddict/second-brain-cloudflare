import { FTS_MIN_TOKEN_LENGTH, FTS_READY_CACHE_MS, FTS_READY_KV_KEY } from "../constants";
import type { Env } from "../env";

const NUL_TOKEN = /\u0000/;

// Single source of truth for FTS token eligibility: routing and the builder
// must agree, or a mixed query silently hides the entries its ineligible
// tokens would have matched via LIKE. A token qualifies only when the trigram
// index can ever match it (at least FTS_MIN_TOKEN_LENGTH codepoints) and its
// string can reach the query intact (no NUL — SQLite truncates at \0 and
// MATCH throws).
export function ftsEligibleToken(t: string): boolean {
  return [...t].length >= FTS_MIN_TOKEN_LENGTH && !NUL_TOKEN.test(t);
}

export function ftsMatchQuery(tokens: string[]): string | null {
  const eligible = tokens.filter(ftsEligibleToken);
  if (!eligible.length) return null;
  return eligible.map(t => `"${t.replaceAll(`"`, `""`)}"`).join(" OR ");
}

// The readiness answer is cached in BOTH directions for FTS_READY_CACHE_MS, so
// a stable warm isolate pays one KV read per window in either state. False must
// be cached too: without it every recall on a cold-but-backfilling brain pays a
// KV read just to stay on LIKE, which is the pre-arm read rate the arm was meant
// to cut. The expiry is the self-heal's propagation delay — after the nightly
// integrity check clears the flag, an isolate keeps serving FTS for at most
// FTS_READY_CACHE_MS. A KV FAILURE returns false and is NOT cached, so the next
// call retries instead of pinning LIKE for a constant window on a transient
// binding error.
let readyCache: { ready: boolean; at: number } | null = null;

/** Test seam — the cache is module-scoped. */
export function resetFtsReadyMemo(): void { readyCache = null; }

// Write-path isolation v2.2. INVARIANT: FTS is live only if entries_fts
// exists AND all three sync triggers exist. The KV ready flag only means
// "the backfill is complete" — it is never sufficient on its own, because a
// hot-path repair can drop the triggers (leaving a stale, trigger-less but
// still-queryable table) with no KV write at all. Correctness never depends
// on KV; this is the structural check that does not.
export const FTS_LIVENESS_SQL =
  `SELECT count(*) AS n FROM sqlite_master WHERE ` +
  `(type = 'table' AND name = 'entries_fts') OR ` +
  `(type = 'trigger' AND name IN ('entries_fts_insert','entries_fts_update','entries_fts_delete'))`;

/** Interprets one row from FTS_LIVENESS_SQL. Exactly 4 objects (the table plus all three triggers) means live. */
export function isFtsLiveCount(row: { n: number } | null | undefined): boolean {
  return row?.n === 4;
}

/**
 * Standalone liveness check (one D1 call): the nightly backfill's own gate.
 * A caller that already issues a query against entries_fts in the SAME
 * request — recall's keyword search — should NOT call this: it would cost a
 * second subrequest. Bundle FTS_LIVENESS_SQL into that caller's own
 * `env.DB.batch([...])` instead, and read the count with isFtsLiveCount.
 */
export async function isFtsLive(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(FTS_LIVENESS_SQL).first<{ n: number }>();
  return isFtsLiveCount(row);
}

export async function ftsReady(env: Env): Promise<boolean> {
  const now = Date.now();
  if (readyCache && now - readyCache.at < FTS_READY_CACHE_MS) return readyCache.ready;
  try {
    const ready = (await env.OAUTH_KV.get(FTS_READY_KV_KEY)) === "1";
    readyCache = { ready, at: now };
    return ready;
  } catch (e) {
    console.error("FTS ready-flag read failed (staying on LIKE):", e);
    return false;
  }
}
