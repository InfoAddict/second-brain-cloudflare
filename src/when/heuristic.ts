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
 */

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

/** Constructs a local-midnight timestamp, or null if the calendar date does not exist. */
function localDate(year: number, month0: number, day: number): number | null {
  const d = new Date(year, month0, day);
  if (d.getFullYear() !== year || d.getMonth() !== month0 || d.getDate() !== day) return null;
  return d.getTime();
}

/** Same round-trip validity check, for a UTC-anchored ISO date. */
function utcDate(year: number, month0: number, day: number): number | null {
  const at = Date.UTC(year, month0, day);
  const d = new Date(at);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month0 || d.getUTCDate() !== day) return null;
  return at;
}

function collectCandidates(content: string, now: number): number[] {
  const found: number[] = [];
  const currentYear = new Date(now).getFullYear();

  for (const m of content.matchAll(ISO_DATE)) {
    const at = utcDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (at !== null) found.push(at);
  }

  for (const m of content.matchAll(MONTH_DAY)) {
    const month0 = monthIndex(m[1]);
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : currentYear;
    const at = localDate(year, month0, day);
    if (at !== null) found.push(at);
  }

  for (const m of content.matchAll(SLASH_DATE)) {
    const at = localDate(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    if (at !== null) found.push(at);
  }

  return found;
}

/**
 * The soonest unambiguous future date in `content`, or null. `now` is
 * injectable for tests; production callers leave it as the real clock.
 */
export function extractUnambiguousDate(content: string, now: number = Date.now()): number | null {
  const future = collectCandidates(content, now).filter(at => at > now);
  if (!future.length) return null;
  return Math.min(...future);
}
