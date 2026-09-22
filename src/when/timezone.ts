/**
 * Anchoring a date-only or offsetless `when` in an IANA zone (config.TIMEZONE)
 * rather than always UTC. A bare "2026-06-15" means that calendar date
 * wherever the brain is configured to live, not the date UTC happened to be
 * showing — the earlier UTC-anchored version turned "overdue" at 8pm the
 * evening before for a US Eastern user, so a push notification would fire a
 * night early.
 *
 * DST-aware by construction: the offset is derived for the target date
 * itself via Intl.DateTimeFormat, not a fixed shortcut, since the same zone
 * can differ by an hour depending on the time of year.
 */

/**
 * The wall-clock reading of `utcMs` in `timezone`, reinterpreted as if that
 * reading were itself a UTC instant. Not a real instant — a bookkeeping
 * number used only to measure the zone's offset at `utcMs` (see
 * zonedTimeMs below).
 */
function wallClockAsUtcMs(timezone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(utcMs);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/**
 * The UTC instant at which the wall clock in `timezone` reads exactly
 * year-month0-day hour:minute:second. One correction pass: guess the instant
 * as if the wall-clock digits were themselves UTC, measure that guess's real
 * offset in the target zone, then shift by it. Only wrong within the same
 * calendar day as a DST transition that lands on this exact wall-clock time,
 * an edge case not worth a second correction pass for a due-date anchor.
 */
export function zonedTimeMs(
  year: number, month0: number, day: number,
  hour: number, minute: number, second: number,
  timezone: string,
): number {
  const guess = Date.UTC(year, month0, day, hour, minute, second);
  if (timezone === "UTC") return guess;
  const offset = wallClockAsUtcMs(timezone, guess) - guess;
  return guess - offset;
}

/** Midnight of year-month0-day in `timezone`. */
export function zonedMidnightMs(year: number, month0: number, day: number, timezone: string): number {
  return zonedTimeMs(year, month0, day, 0, 0, 0, timezone);
}

/** Matches a bare ISO date or datetime with no offset — the two shapes this module anchors. */
const BARE_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Parses a bare ("no offset") ISO 8601 date or datetime string and anchors it
 * in `timezone`, or null if the string is not one of those two shapes —
 * callers with an offset already (a "Z" or "+02:00") should not route
 * through this at all; see src/when/input.ts's HAS_TIMEZONE_RE guard.
 */
export function zonedMsFromBareIso(raw: string, timezone: string): number | null {
  const m = BARE_DATE_TIME_RE.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return zonedTimeMs(
    Number(y), Number(mo) - 1, Number(d),
    h ? Number(h) : 0, mi ? Number(mi) : 0, s ? Number(s) : 0,
    timezone,
  );
}
