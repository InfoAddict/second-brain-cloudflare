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
    [/\baround\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/i, m => {
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
  const DATE_PREPOSITIONS = "on|since|before|after|by|until|from";
  const explicit = new RegExp(`\\b(?:(?:${DATE_PREPOSITIONS})\\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\b`, "gi");

  // A month-day match isn't always a question date. It can be a proper noun ("the Aug 8 Velmora
  // Cafe", "the May 5 cafe": preceded by an article, so the match modifies a following noun
  // instead of standing alone as a temporal adverbial), or an "as of" phrase, which Track 2's
  // as-of path doesn't exist yet to answer (docs/superpowers/specs/2026-09-26-v4/
  // 02-time-aware-truth.md), so it must not become a same-day window. Both are excluded here
  // rather than treated as a date. A date preposition ("on May 5 New York time") or a trailing
  // timezone/time word overrides the article check either way: those stay genuine regardless of
  // what named-looking text follows.
  const isAsOfPhrase = (index: number) => /\bas\s+of\s*$/i.test(query.slice(0, index));
  const precededByDatePreposition = (matchText: string) => new RegExp(`^(?:${DATE_PREPOSITIONS})\\s+`, "i").test(matchText);
  const precededByArticle = (index: number) => /\b(?:the|a|an)\s*$/i.test(query.slice(0, index));
  const followedByTimeWord = (index: number, length: number) => /^\s+(?:time\b|o'?clock\b|[ap]\.?m\.?\b|(?:UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|CET|CEST|BST|JST|IST)\b)/i.test(query.slice(index + length));

  const calendarValid = [...query.matchAll(explicit)].filter(match => {
    const year = match[3] ? Number(match[3]) : d.getFullYear();
    const month = monthNumber[match[1].toLowerCase().slice(0, 3)];
    const day = Number(match[2]);
    return isValidCalendarDate(year, month, day);
  });
  const genuine = calendarValid.filter(match => {
    if (match.index === undefined) return false;
    if (precededByDatePreposition(match[0])) return true;
    if (isAsOfPhrase(match.index)) return false;
    if (precededByArticle(match.index)) return false;
    if (followedByTimeWord(match.index, match[0].length)) return true;
    return !/^\s+[A-Z]/.test(query.slice(match.index + match[0].length));
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
