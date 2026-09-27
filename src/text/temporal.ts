export function parseTimePhrase(query: string, now: number): { after?: number; before?: number; cleanQuery: string } {
  const MS_DAY = 86400000;
  const MS_WEEK = 7 * MS_DAY;
  const d = new Date(now);
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const startOfWeek = (date: Date) => {
    const dow = date.getDay();
    const diff = dow === 0 ? -6 : 1 - dow;
    return startOfDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff));
  };
  const isValidCalendarDate = (year: number, month: number, day: number) => {
    const candidate = new Date(year, month, day);
    return candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === day;
  };
  const ORDINAL_SUFFIX = "(?:st|nd|rd|th)?";

  type TimeResult = { after?: number; before?: number };
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => TimeResult | undefined]> = [
    [/\blast\s+(\d+)\s+days?\b/i, m => ({ after: now - parseInt(m[1]) * MS_DAY })],
    [/\blast\s+(\d+)\s+weeks?\b/i, m => ({ after: now - parseInt(m[1]) * MS_WEEK })],
    [/\blast\s+week\b/i, () => ({ after: now - MS_WEEK })],
    [/\bthis\s+week\b/i, () => ({ after: startOfWeek(d) })],
    [/\blast\s+month\b/i, () => ({
      after: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(),
      before: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    })],
    [/\bthis\s+month\b/i, () => ({ after: new Date(d.getFullYear(), d.getMonth(), 1).getTime() })],
    // "as of yesterday" also matches this and becomes a created-at filter; that is Track 2 as-of
    // semantics (an as-of read, not a creation-window filter) and is deferred to T2 lane C.
    [/\byesterday\b/i, () => {
      const s = startOfDay(d) - MS_DAY;
      return { after: s, before: s + MS_DAY };
    }],
    [/\btoday\b/i, () => ({ after: startOfDay(d) })],
    [new RegExp(`\\baround\\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+(\\d{1,2})${ORDINAL_SUFFIX}\\b`, "i"), m => {
      const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
      const day = parseInt(m[2]);
      if (!isValidCalendarDate(d.getFullYear(), month, day)) return undefined;
      const center = new Date(d.getFullYear(), month, day).getTime();
      return { after: center - 3 * MS_DAY, before: center + 3 * MS_DAY };
    }],
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

  // Safe failure mode: a wrong filter hides the right memory; a missing filter only broadens
  // results. So a month-day match only becomes a same-day filter when nothing else could explain
  // it, and the checks below all lean toward no filter rather than a guessed one:
  //  - "as of <date>" is a future as-of read (Track 2 lane C), never a created-on-that-day filter.
  //  - "by/until/before/after/since/from <date>" name a range or an open end that a same-day
  //    window would misrepresent; the parser has no range semantics for them, so it produces no
  //    filter at all for the whole query rather than guess one (a preposition never rescues a
  //    date the checks below would otherwise reject, and never causes an incorrect one either).
  //  - Anything else immediately following the date (a name, a description) means it isn't
  //    standing alone as a temporal adverbial, unless that text is itself a timezone or time
  //    expression ("New York time", "EST"), which confirms rather than contradicts a real date.
  const isAsOfPhrase = (index: number) => /\bas\s+of\s*$/i.test(query.slice(0, index));
  const BLOCKED_PREPOSITIONS = "by|until|before|after|since|from";
  const precededByBlockedPreposition = (index: number) => new RegExp(`\\b(?:${BLOCKED_PREPOSITIONS})\\s*$`, "i").test(query.slice(0, index));
  // Scans past a run of capitalized words ("New York") to find the time-zone or time expression
  // that confirms them: "New York time" and "New York EST" both count, "New York" alone does not.
  const followedByTimeWord = (index: number, length: number) => /^\s+(?:[A-Z][a-zA-Z]*\s+)*(?:time\b|o'?clock\b|[ap]\.?m\.?\b|(?:UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|CET|CEST|BST|JST|IST)\b)/.test(query.slice(index + length));

  const calendarValid = [...query.matchAll(explicit)].filter(match => {
    const year = match[3] ? Number(match[3]) : d.getFullYear();
    const month = monthNumber[match[1].toLowerCase().slice(0, 3)];
    const day = Number(match[2]);
    return isValidCalendarDate(year, month, day);
  });

  if (calendarValid.some(match => match.index !== undefined && precededByBlockedPreposition(match.index))) {
    return { cleanQuery: query };
  }

  const genuine = calendarValid.filter(match => {
    if (match.index === undefined) return false;
    if (isAsOfPhrase(match.index)) return false;
    if (followedByTimeWord(match.index, match[0].length)) return true;
    return !/^\s+\S/.test(query.slice(match.index + match[0].length));
  });

  if (genuine.length === 1) {
    const match = genuine[0];
    const year = match[3] ? Number(match[3]) : d.getFullYear();
    const month = monthNumber[match[1].toLowerCase().slice(0, 3)];
    const day = Number(match[2]);
    const after = new Date(year, month, day).getTime();
    const cleanQuery = query
      .replace(match[0], "")
      .replace(/,\s*(?=[?!.,;:]|$)/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s+([?!.,;:])/g, "$1")
      .trim() || query;
    return { after, before: new Date(year, month, day + 1).getTime(), cleanQuery };
  }

  return { cleanQuery: query };
}
