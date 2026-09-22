/**
 * Free date extraction at capture time: pure regex, no model call, in the
 * style of src/staleness/heuristic.ts. Extracts ONLY unambiguous absolute
 * dates — ISO (2026-09-30), month-name ("Sep 30 2026", "September 30"), and
 * slash with a 4-digit year (9/30/2026). Nothing fuzzy: "Friday", "next
 * week", "end of month" need a reader's sense of "when is this relative to",
 * which is exactly what src/when/pass.ts's model call is for. No dot-form
 * (M.D.YY) either — that would also match a version number like "3.4.0".
 *
 * A bare month-day with no year assumes the CURRENT year and is discarded if
 * that has already passed, rather than rolled to next year — rolling forward
 * is a guess about which year was meant, and this pass does not guess.
 *
 * WHITESPACE-TOKEN GUARD (Finding 4). `\b` alone is not enough: it treats "/"
 * and "=" as word boundaries too, so "2026-09-30" inside
 * ".../reports/2026-09-30/summary.pdf" or "build_id=2026-09-30-04" matched
 * and silently became a due date. A match only counts when the text
 * immediately before it is whitespace or the start of the content, and the
 * text immediately after it is whitespace, the end of the content, or a
 * single terminal punctuation mark (.,;:!?)") followed by whitespace/end.
 *
 * SLASH-DATE AMBIGUITY (Finding 6). m/d/yyyy is rejected outright when BOTH
 * fields are <= 12 and differ — "9/10/2026" could genuinely be read as
 * September 10 or October 9, and this pass does not guess which. "9/30/2026"
 * is not ambiguous this way: 30 cannot be a month, so only one reading
 * parses at all.
 */

import { zonedMidnightMs } from "./timezone";

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_PATTERN = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const monthIndex = (name: string): number => MONTH_NAMES.indexOf(name.toLowerCase().slice(0, 3));

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
// The (?!-\d) guard is what keeps "July 25-26, 2025" from being read as the
// bare, yearless "July 25" — without it the year binds to "26" and the "25"
// half matches standalone, silently discarding the "2025" that would have
// shown it was already past. A range is excluded entirely rather than
// half-matched, matching "unambiguous only".
const MONTH_DAY = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!-\\d)(?:,\\s*|\\s+)?(\\d{4})?\\b`, "gi");
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;

/** A single terminal mark a date is allowed to be followed by before end/whitespace. */
const TERMINAL_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "\""]);
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * True when `content[start, end)` sits in its own whitespace-delimited token
 * — nothing but whitespace/start before it, nothing but whitespace/end (or
 * exactly one terminal punctuation mark, then whitespace/end) after it. See
 * the WHITESPACE-TOKEN GUARD note above.
 */
function isIsolatedToken(content: string, start: number, end: number): boolean {
  if (!isSpace(content[start - 1])) return false;
  if (isSpace(content[end])) return true;
  return TERMINAL_PUNCTUATION.has(content[end]) && isSpace(content[end + 1]);
}

/**
 * Midnight of the calendar date, anchored in `timezone` (src/config.ts's
 * TIMEZONE, "UTC" for a brain that never sets it) — or null if the calendar
 * date does not exist (a real round-trip check: Date.UTC on an
 * out-of-range day/month rolls over silently rather than failing).
 */
function anchoredDate(year: number, month0: number, day: number, timezone: string): number | null {
  const at = zonedMidnightMs(year, month0, day, timezone);
  // The round-trip check reads the date back out in the SAME timezone the
  // anchor used, not UTC — a UTC read of a zone-shifted instant can land on
  // the wrong calendar day entirely and reject a perfectly valid date.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? NaN);
  if (get("year") !== year || get("month") - 1 !== month0 || get("day") !== day) return null;
  return at;
}

function collectCandidates(content: string, now: number, timezone: string): number[] {
  const found: number[] = [];
  const currentYear = new Date(now).getFullYear();

  for (const m of content.matchAll(ISO_DATE)) {
    if (!isIsolatedToken(content, m.index, m.index + m[0].length)) continue;
    const at = anchoredDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), timezone);
    if (at !== null) found.push(at);
  }

  for (const m of content.matchAll(MONTH_DAY)) {
    if (!isIsolatedToken(content, m.index, m.index + m[0].length)) continue;
    const month0 = monthIndex(m[1]);
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : currentYear;
    const at = anchoredDate(year, month0, day, timezone);
    if (at !== null) found.push(at);
  }

  for (const m of content.matchAll(SLASH_DATE)) {
    if (!isIsolatedToken(content, m.index, m.index + m[0].length)) continue;
    const first = Number(m[1]);
    const second = Number(m[2]);
    // Genuinely ambiguous: both readings (month/day and day/month) are
    // structurally valid and disagree. Equal fields agree either way, and
    // either field over 12 rules out the other reading, so neither is
    // rejected here.
    if (first <= 12 && second <= 12 && first !== second) continue;
    const at = anchoredDate(Number(m[3]), first - 1, second, timezone);
    if (at !== null) found.push(at);
  }

  return found;
}

/**
 * The soonest unambiguous future date in `content`, or null. `now` is
 * injectable for tests; production callers leave it as the real clock.
 * `timezone` anchors every candidate date (src/config.ts's TIMEZONE); "UTC"
 * for a brain that never configures one.
 */
export function extractUnambiguousDate(content: string, now: number = Date.now(), timezone: string = "UTC"): number | null {
  const future = collectCandidates(content, now, timezone).filter(at => at > now);
  if (!future.length) return null;
  return Math.min(...future);
}
