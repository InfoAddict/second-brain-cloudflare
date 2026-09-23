import { FTS_MIN_TOKEN_LENGTH, FTS_READY_CACHE_MS, FTS_READY_KV_KEY } from "../constants";
import type { Env } from "../env";
import {
  ENTRIES_FTS_TABLE_DDL,
  ENTRIES_FTS_INSERT_TRIGGER_DDL,
  ENTRIES_FTS_UPDATE_TRIGGER_DDL,
  ENTRIES_FTS_DELETE_TRIGGER_DDL,
} from "../db/init";

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
// exists AND all three sync triggers exist, WITH the exact bodies we create
// (S1, v2.2 re-review): a right-named trigger with a tampered or drifted
// body is not enough — a name match alone lets a corrupted sync silently
// serve an incomplete index, since the trigger still "exists" and the MATCH
// query still succeeds. The KV ready flag only means "the backfill is
// complete" — it is never sufficient on its own, because a hot-path repair
// can drop the triggers (leaving a stale, trigger-less but still-queryable
// table) with no KV write at all. Correctness never depends on KV; this is
// the structural check that does not.
export const FTS_LIVENESS_SQL =
  `SELECT name, sql FROM sqlite_master WHERE ` +
  `(type = 'table' AND name = 'entries_fts') OR ` +
  `(type = 'trigger' AND name IN ('entries_fts_insert','entries_fts_update','entries_fts_delete'))`;

// SQLite stores a CREATE statement's text verbatim in sqlite_master.sql,
// including whitespace — EXCEPT it strips "IF NOT EXISTS" (verified against
// real node:sqlite). The table DDL never had it to begin with (ownership,
// v2.2); the trigger DDLs still carry it (only the table's creation needs
// to fail atomically on a collision), so stripping it here is the only
// normalization needed — not a general whitespace/token normalizer.
const EXPECTED_FTS_DEFINITIONS: Record<string, string> = {
  entries_fts: ENTRIES_FTS_TABLE_DDL,
  entries_fts_insert: ENTRIES_FTS_INSERT_TRIGGER_DDL.replace(/\bIF NOT EXISTS\s+/i, ""),
  entries_fts_update: ENTRIES_FTS_UPDATE_TRIGGER_DDL.replace(/\bIF NOT EXISTS\s+/i, ""),
  entries_fts_delete: ENTRIES_FTS_DELETE_TRIGGER_DDL.replace(/\bIF NOT EXISTS\s+/i, ""),
};

/**
 * Interprets the rows from FTS_LIVENESS_SQL. Live only when all four
 * objects are present AND each one's stored `sql` is byte-for-byte the
 * definition we would create — this is also the upgrade path for a future
 * release that changes a trigger body: the old body reads as not-live and
 * is picked up by the nightly rebuild, not silently left running.
 */
export function isFtsLiveRows(rows: { name: string; sql: string | null }[] | null | undefined): boolean {
  if (!rows || rows.length !== 4) return false;
  return rows.every(row => EXPECTED_FTS_DEFINITIONS[row.name] === row.sql);
}

/**
 * Standalone liveness check (one D1 call): the nightly backfill's own gate.
 * A caller that already issues a query against entries_fts in the SAME
 * request — recall's keyword search — should NOT call this: it would cost a
 * second subrequest. Bundle FTS_LIVENESS_SQL into that caller's own
 * `env.DB.batch([...])` instead, and read the rows with isFtsLiveRows.
 */
export async function isFtsLive(env: Env): Promise<boolean> {
  const { results } = await env.DB.prepare(FTS_LIVENESS_SQL).all<{ name: string; sql: string | null }>();
  return isFtsLiveRows(results);
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
