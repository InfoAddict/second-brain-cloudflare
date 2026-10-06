import { zonedDateParts, zonedMidnightMs } from "../when/timezone";

/**
 * Relative and explicit dates read in `timezone` (the brain's configured
 * TIMEZONE, "UTC" by default): "yesterday" at 11pm in a Pacific brain is
 * still yesterday there, even after UTC has turned over to the next day.
 * Text matching and phrase-stripping stay on the raw query string, which is
 * timezone-independent; only the wall-clock-to-instant conversions below use
 * `timezone`.
 */
export function parseTimePhrase(query: string, now: number, timezone: string = "UTC"): { after?: number; before?: number; cleanQuery: string } {
  const MS_DAY = 86400000;
  const MS_WEEK = 7 * MS_DAY;
  const nowParts = zonedDateParts(now, timezone);
  const dayMs = (year: number, month0: number, day: number) => zonedMidnightMs(year, month0, day, timezone);
  const startOfDay = () => dayMs(nowParts.year, nowParts.month0, nowParts.day);
  const startOfWeek = () => {
    const dow = nowParts.weekday;
    const diff = dow === 0 ? -6 : 1 - dow;
    return dayMs(nowParts.year, nowParts.month0, nowParts.day + diff);
  };
  const isValidCalendarDate = (year: number, month: number, day: number) => {
    const candidate = new Date(year, month, day);
    return candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === day;
  };
  const ORDINAL_SUFFIX = "(?:st|nd|rd|th)?";

  // Safe failure mode, shared by every handler that can match month-day-shaped text: a wrong
  // filter hides the right memory; a missing filter only broadens results. So a match only
  // becomes a filter when nothing else could explain the text right after it: nothing follows, or
  // what follows (after any run of capitalized words) is a timezone or time expression ("New York
  // time", "EST"). Any other following text, name or description, capitalized or not, means the
  // match isn't standing alone as a temporal phrase. Relative phrases below ("yesterday", "last
  // week") have no such collision risk with a name ("yesterday Cafe" isn't an English business
  // name the way "Aug 8 Cafe" reads as one) and are intentionally not guarded by this.
  const isSafeToFilter = (remainder: string): boolean => {
    if (/^\s+(?:[A-Z][a-zA-Z]*\s+)*(?:time\b|o'?clock\b|[ap]\.?m\.?\b|(?:UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|CET|CEST|BST|JST|IST)\b)/.test(remainder)) return true;
    return !/^\s+\S/.test(remainder);
  };

  type TimeResult = { after?: number; before?: number };
  type Handler = (m: RegExpMatchArray) => TimeResult | undefined;
  const guarded = (handler: Handler): Handler => m => {
    const result = handler(m);
    if (!result) return undefined;
    return isSafeToFilter(query.slice((m.index ?? 0) + m[0].length)) ? result : undefined;
  };

  const patterns: Array<[RegExp, Handler]> = [
    [/\blast\s+(\d+)\s+days?\b/i, m => ({ after: now - parseInt(m[1]) * MS_DAY })],
    [/\blast\s+(\d+)\s+weeks?\b/i, m => ({ after: now - parseInt(m[1]) * MS_WEEK })],
    [/\blast\s+week\b/i, () => ({ after: now - MS_WEEK })],
    [/\bthis\s+week\b/i, () => ({ after: startOfWeek() })],
    [/\blast\s+month\b/i, () => ({
      after: dayMs(nowParts.year, nowParts.month0 - 1, 1),
      before: dayMs(nowParts.year, nowParts.month0, 1),
    })],
    [/\bthis\s+month\b/i, () => ({ after: dayMs(nowParts.year, nowParts.month0, 1) })],
    // "as of yesterday" also matches this and becomes a created-at filter; that is Track 2 as-of
    // semantics (an as-of read, not a creation-window filter) and is deferred to T2 lane C.
    [/\byesterday\b/i, () => ({
      after: dayMs(nowParts.year, nowParts.month0, nowParts.day - 1),
      before: dayMs(nowParts.year, nowParts.month0, nowParts.day),
    })],
    [/\btoday\b/i, () => ({ after: startOfDay() })],
    // The only relative-phrase-array handler that matches month-day text, so the only one here
    // guarded: "around May 5th Cafe" must not become a six-day filter (T-0105.4).
    [new RegExp(`\\baround\\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+(\\d{1,2})${ORDINAL_SUFFIX}\\b`, "i"), guarded(m => {
      const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
      const day = parseInt(m[2]);
      if (!isValidCalendarDate(nowParts.year, month, day)) return undefined;
      const center = dayMs(nowParts.year, month, day);
      return { after: center - 3 * MS_DAY, before: center + 3 * MS_DAY };
    })],
  ];

  for (const [pattern, handler] of patterns) {
    const match = query.match(pattern);
    if (match) {
      const result = handler(match);
      if (result) {
        const cleanQuery = query.replace(pattern, '').replace(/\s+/g, ' ').trim() || query;
        return { ...result, cleanQuery };
      }
    }
  }

  const monthNumber: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const explicit = new RegExp(`\\b(?:on\\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+(\\d{1,2})${ORDINAL_SUFFIX}(?:,\\s*(\\d{4}))?\\b`, "gi");

  // "as of <date>" is a future as-of read (Track 2 lane C), never a created-on-that-day filter.
  // "by/until/before/after/since/from <date>" name a range or an open end this parser has no
  // semantics for, so they produce no filter at all rather than guess one: a preposition never
  // rescues a date isSafeToFilter would otherwise reject, and never causes an incorrect one either.
  const isAsOfPhrase = (index: number) => /\bas\s+of\s*$/i.test(query.slice(0, index));
  const BLOCKED_PREPOSITIONS = "by|until|before|after|since|from";
  const precededByBlockedPreposition = (index: number) => new RegExp(`\\b(?:${BLOCKED_PREPOSITIONS})\\s*$`, "i").test(query.slice(0, index));

  const calendarValid = [...query.matchAll(explicit)].filter(match => {
    const year = match[3] ? Number(match[3]) : nowParts.year;
    const month = monthNumber[match[1].toLowerCase().slice(0, 3)];
    const day = Number(match[2]);
    return isValidCalendarDate(year, month, day);
  });

  if (calendarValid.some(match => match.index !== undefined && precededByBlockedPreposition(match.index))) {
    return { cleanQuery: query };
  }

  const genuine = calendarValid.filter(match =>
    match.index !== undefined
    && !isAsOfPhrase(match.index)
    && isSafeToFilter(query.slice(match.index + match[0].length)));

  if (genuine.length === 1) {
    const match = genuine[0];
    const year = match[3] ? Number(match[3]) : nowParts.year;
    const month = monthNumber[match[1].toLowerCase().slice(0, 3)];
    const day = Number(match[2]);
    const after = dayMs(year, month, day);
    const cleanQuery = query
      .replace(match[0], "")
      .replace(/,\s*(?=[?!.,;:]|$)/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s+([?!.,;:])/g, "$1")
      .trim() || query;
    return { after, before: dayMs(year, month, day + 1), cleanQuery };
  }

  return { cleanQuery: query };
}
