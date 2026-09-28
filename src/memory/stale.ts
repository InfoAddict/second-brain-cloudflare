import { withoutVolatility } from "./volatility";
import { currentValidityAt, SQL_NOW_MS } from "./validity";

export const STALE_AS_OF = "stale:as-of";

/**
 * The out-of-date review queue, as a WHERE clause.
 *
 * One definition, used by both the count on home and the queue behind it, so the
 * chip cannot promise a number the list then fails to produce. Matches the quoted
 * JSON member rather than a bare substring, the same way PENDING_INSIGHT_SQL does.
 *
 * Deprecated entries are excluded: deprecation retires a memory from recall, and
 * asking someone to re-verify something already out of circulation is make-work. So are
 * replaced and ended ones (T-0089.2.1): a closed window is history, not a claim to re-check.
 * The fragment has no binding of its own, so "current" is read against the database clock.
 */
export const STALE_REVIEW_SQL =
  `tags LIKE '%"${STALE_AS_OF}"%' AND tags NOT LIKE '%"status:deprecated"%' AND ${currentValidityAt("", SQL_NOW_MS)}`;

export function hasStaleAsOf(tags: string[]): boolean {
  return tags.includes(STALE_AS_OF);
}

export function withStaleAsOf(tags: string[]): string[] {
  if (tags.includes(STALE_AS_OF)) return tags;
  return [...tags, STALE_AS_OF];
}

export function withoutStaleAsOf(tags: string[]): string[] {
  return tags.filter(t => t !== STALE_AS_OF);
}

/** Strip staleness/volatility system tags after a content-changing write. */
export function tagsAfterWrite(tags: string[]): string[] {
  return withoutVolatility(withoutStaleAsOf(tags));
}

/**
 * Tag treatment for an append, which keeps the original content and adds to it.
 *
 * The as-of qualifier clears because updated_at moves and it would otherwise report a
 * date this entry no longer has. The volatility verdict is kept, because it describes a
 * fact that is still present in the body — the same reasoning that keeps `rolled-up` on
 * an append and drops it on a replacement (see capture/store.ts).
 *
 * Stripping it here would also make the verdict depend on how a memory was edited rather
 * than on what it says: the same fact would be classified or not according to whether the
 * user appended to it, a distinction the user never made. Recovery is not prompt either,
 * because the pass reconsiders a row only once it has gone untouched past the age gate,
 * and an append resets that clock.
 */
export function tagsAfterAppend(tags: string[]): string[] {
  return withoutStaleAsOf(tags);
}

export function formatAsOfQualifier(updatedAt: number): string {
  // Spelled month: assistants read this qualifier and act on the date.
  const date = new Date(updatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  return `true as of ${date}, verify before asserting`;
}
