import { FTS_MIN_TOKEN_LENGTH, FTS_READY_CACHE_MS, FTS_READY_KV_KEY } from "../constants";
import type { Env } from "../env";

const NUL_TOKEN = /\u0000/;

// FTS5 has its own query grammar; a bare token like #149 or won't is a syntax
// error. Double-quoting makes every token a string literal (internal quotes
// doubled), and trigram matches it as a substring — the LIKE semantics recall
// has always had. Tokens under the trigram floor can never match and are
// dropped; null tells the caller nothing survived, so LIKE must serve. A token
// carrying NUL joins them: SQLite truncates its query at \0 and MATCH throws
// instead of matching.
export function ftsMatchQuery(tokens: string[]): string | null {
  const eligible = tokens.filter(t => !NUL_TOKEN.test(t) && [...t].length >= FTS_MIN_TOKEN_LENGTH);
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
