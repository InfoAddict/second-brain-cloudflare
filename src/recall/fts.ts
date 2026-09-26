import { FTS_MATCH_BUDGET, FTS_MIN_TOKEN_LENGTH, FTS_READY_CACHE_MS, FTS_READY_KV_KEY } from "../constants";
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

// A token the trigram index can never match only because it is too short. It
// cannot be retrieved through FTS, but it is still a real word (a two-character
// CJK word, "k8", "io"), so the router weighs it in fusion instead of letting
// it veto the index for the other tokens. NUL tokens are not this: they stay
// on the LIKE path with the rest of the query.
export function ftsShortToken(t: string): boolean {
  return [...t].length < FTS_MIN_TOKEN_LENGTH && !NUL_TOKEN.test(t);
}

export function ftsMatchQuery(tokens: string[]): string | null {
  const eligible = tokens.filter(ftsEligibleToken);
  if (!eligible.length) return null;
  return eligible.map(t => `"${t.replaceAll(`"`, `""`)}"`).join(" OR ");
}

// LIKE folds only ASCII case; the trigram tokenizer's casefold covers all of
// Unicode (verified against real node:sqlite: content "RESUME" with an
// uppercase accented E matches a lowercase-accented-E MATCH query, but not a
// LIKE '%...%' with the same lowercase term). A term is safe to COUNT via the
// FTS index only when that gap can never move its count: no non-ASCII
// character with a case distinction (CJK and digits have none and are
// unaffected either way). T-0059's equivalence proof requires FTS df to equal
// LIKE df for every uncapped term, so a term this returns false for is routed
// back to the LIKE scan instead of risking a silently different df.
const NON_ASCII = /[^\x00-\x7F]/;
export function ftsCountSafeToken(t: string): boolean {
  if (!NON_ASCII.test(t)) return true;
  return [...t].every(ch => !NON_ASCII.test(ch) || ch.toLowerCase() === ch.toUpperCase());
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

const quoteToken = (t: string) => `"${t.replaceAll(`"`, `""`)}"`;

/**
 * The MATCH strings the FTS arm runs for eligible tokens, in candidate priority
 * order, or null when only the LIKE arm can serve the query. `bounded` says the
 * plan was cut to fit the budget; `andTier` says matches[0] is the AND tier,
 * which the caller runs newest-first without a bm25 sort (see below).
 *
 * Within FTS_MATCH_BUDGET (or when df does not cover every token) that is one
 * bm25-ranked OR over every token, as ever. Past the budget bm25 would score
 * every match, so the plan is bounded instead, in two tiers merged in this
 * order: an AND over all tokens, then a bm25-ranked OR over the rarest tokens
 * whose df still sums within FTS_MATCH_BUDGET. Common words the plan leaves out
 * are still weighed in fusion.
 *
 * The OR tier scores at most FTS_MATCH_BUDGET matches to pick the best
 * KEYWORD_CANDIDATE_LIMIT of them, so the budget is not tied to the limit:
 * scoring more matches than the limit returns is what lets relevance, not
 * recency, choose the survivors. It was measured lower (500, 1000) on workerd
 * with guards whose answer carries only some of the query's tokens, each a
 * mid-df one: the OR tier found 0 of 6 at 500 and 3 of 6 at 1000 (6 of 6 at
 * FTS_MATCH_BUDGET) at 5k and 20k, in exchange for fewer rows read (over-budget
 * queries at 5k: 12937 at the budget, 7511 at 500). A token whose df is
 * past FTS_MATCH_BUDGET cannot join the tier; an answer carrying only such a
 * token is reachable through the AND tier or the dense arm.
 *
 * The AND tier's cost is not bounded by any budget: its matches are at most the
 * rarest token's df, which is unbounded when the words co-occur (three words
 * that always appear together match the whole partition). Sorting by bm25 would
 * score them all, so it runs as `ORDER BY entries_fts.rowid DESC LIMIT ?`: the
 * FTS index scans in reverse rowid order and stops at the LIMIT, with no sort.
 * That is newest first because rowids follow insertion, and insertion follows
 * time on every write path: capture stamps created_at = now, and a restore
 * (POST /import) inserts oldest first whatever order the file is in. The one
 * exception is an older archive merged into a brain that already holds newer
 * rows: the archive is inserted after them, so when more than the limit rows
 * carry every word, this tier prefers the archived rows over the live ones (it
 * still returns rows carrying every word). Ordering by created_at instead
 * fixes that but sorts every match: on workerd at 5k it read 2503 rows with a
 * TEMP B-TREE against 1111 for the rowid scan, and its cost grows with the
 * matches, which is the unbounded cost this tier exists to avoid. It is a
 * precision tier (rows carrying every word); fusion re-ranks whatever it
 * returns.
 *
 * When the OR tier's matches all fit in `limit` (its df sum, at most), it cannot
 * truncate, and every row of the AND tier (which carries all tokens, so at least
 * the OR tier's) is already among them: the AND tier adds no candidate, so the
 * plan leaves it out and saves its statement and reads.
 *
 * A token whose df is 0 is in no row: it empties the AND and adds nothing to
 * the OR, so the plan drops both instead of paying for statements that cannot
 * return a row. That can leave no plan, and a lone token past the budget has
 * none either: null.
 */
export function planFtsMatch(
  eligible: string[],
  df: ReadonlyMap<string, number> | null | undefined,
  limit: number,
): { matches: string[]; bounded: boolean; andTier: boolean } | null {
  const any = eligible.map(quoteToken).join(" OR ");
  if (!df || !eligible.every(t => df.has(t))) return { matches: [any], bounded: false, andTier: false };
  const dfOf = (t: string) => df.get(t) ?? 0;
  if (eligible.reduce((sum, t) => sum + dfOf(t), 0) <= FTS_MATCH_BUDGET) return { matches: [any], bounded: false, andTier: false };
  const fit: string[] = [];
  let spent = 0;
  for (const t of [...eligible].sort((a, b) => dfOf(a) - dfOf(b))) {
    if (spent + dfOf(t) > FTS_MATCH_BUDGET) break;
    spent += dfOf(t);
    if (dfOf(t) > 0) fit.push(t);
  }
  const plan: string[] = [];
  // The AND tier is a subset of the OR tier's rows whenever that tier is non-empty and returns all of its matches.
  const andTier = eligible.length > 1 && eligible.every(t => dfOf(t) > 0) && !(fit.length && spent <= limit);
  if (andTier) plan.push(eligible.map(quoteToken).join(" "));
  if (fit.length) plan.push(fit.map(quoteToken).join(" OR "));
  return plan.length ? { matches: plan, bounded: true, andTier } : null;
}
