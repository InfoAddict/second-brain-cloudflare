import { FTS_MIN_TOKEN_LENGTH, FTS_READY_KV_KEY } from "../constants";
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

// Memoizes only `true`: ready is a one-way latch set by the backfill, so a
// stale false costs one KV read per recall while a memoized false would pin a
// long-lived isolate on the LIKE path after the index is complete.
let ftsReadyMemo = false;

/** Test seam — the memo is module-scoped. */
export function resetFtsReadyMemo(): void { ftsReadyMemo = false; }

export async function ftsReady(env: Env): Promise<boolean> {
  if (ftsReadyMemo) return true;
  try {
    const ready = (await env.OAUTH_KV.get(FTS_READY_KV_KEY)) === "1";
    if (ready) ftsReadyMemo = true;
    return ready;
  } catch (e) {
    console.error("FTS ready-flag read failed (staying on LIKE):", e);
    return false;
  }
}
