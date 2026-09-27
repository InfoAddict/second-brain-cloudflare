import { describe, it, expect } from "vitest";
import { parseTimePhrase } from "../../src/text/temporal";

const NOW = new Date("2026-05-20T12:00:00.000Z").getTime();
const DAY = 86400000;

describe("parseTimePhrase", () => {
  it("turns one explicit month and day into an exact one-day range", () => {
    const r = parseTimePhrase("why was the quartz record revised on August 17", NOW);
    expect(r).toEqual({
      after: new Date(2026, 7, 17).getTime(),
      before: new Date(2026, 7, 18).getTime(),
      cleanQuery: "why was the quartz record revised",
    });
  });

  it("honors an explicit year and removes adjacent punctuation", () => {
    const r = parseTimePhrase("quartz record, August 17, 2024?", NOW);
    expect(r).toEqual({
      after: new Date(2024, 7, 17).getTime(),
      before: new Date(2024, 7, 18).getTime(),
      cleanQuery: "quartz record?",
    });
  });

  it("does not hard-filter comparisons containing multiple explicit dates", () => {
    const query = "why did the quartz record move from June 3 to May 31";
    expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
  });

  it("rejects invalid explicit calendar dates", () => {
    const query = "quartz record on February 31";
    expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
  });
  it("parses 'last 7 days'", () => {
    const r = parseTimePhrase("notes from last 7 days", NOW);
    expect(r.after).toBeCloseTo(NOW - 7 * DAY, -4);
    expect(r.cleanQuery).toBe("notes from");
  });

  it("parses 'yesterday'", () => {
    const r = parseTimePhrase("yesterday meeting notes", NOW);
    expect(r.after).toBeDefined();
    expect(r.before).toBeDefined();
    expect(r.before! - r.after!).toBe(DAY);
  });

  it("parses 'today'", () => {
    const r = parseTimePhrase("today", NOW);
    expect(r.after).toBeDefined();
    expect(r.before).toBeUndefined();
  });

  it("parses 'last week'", () => {
    const r = parseTimePhrase("last week tasks", NOW);
    expect(r.after).toBeCloseTo(NOW - 7 * DAY, -4);
  });

  it("returns query unchanged when no temporal phrase", () => {
    const r = parseTimePhrase("machine learning notes", NOW);
    expect(r.after).toBeUndefined();
    expect(r.before).toBeUndefined();
    expect(r.cleanQuery).toBe("machine learning notes");
  });

  it("is case-insensitive", () => {
    const r = parseTimePhrase("LAST 3 DAYS", NOW);
    expect(r.after).toBeCloseTo(NOW - 3 * DAY, -4);
  });

  it("parses 'last month' as the whole of the previous calendar month", () => {
    const r = parseTimePhrase("last month", NOW);
    // NOW is 20 May 2026, so "last month" is April: [1 Apr, 1 May).
    // The expectation is built with the same local-time constructors the parser
    // uses, so it holds on runners in any timezone rather than pinning a UTC
    // instant that only matches America/New_York.
    expect(r.after).toBe(new Date(2026, 3, 1).getTime());
    expect(r.before).toBe(new Date(2026, 4, 1).getTime());
    // The discriminating property against "this month": the window closes
    // before now, so today is outside it.
    expect(r.before!).toBeLessThanOrEqual(NOW);
  });

  // The bare phrase can't exercise phrase-stripping — replacing the whole query
  // leaves an empty string, and the parser falls back to returning it intact.
  it("strips 'last month' out of a longer query", () => {
    const r = parseTimePhrase("last month invoices", NOW);
    expect(r.cleanQuery).toBe("invoices");
    expect(r.after).toBe(new Date(2026, 3, 1).getTime());
  });

  it("'this week' called on a Sunday walks back 6 days to Monday", () => {
    // Jan 4, 2026 is a Sunday (Jan 1 = Thursday, +3 = Sunday)
    const sunday = new Date(2026, 0, 4, 12, 0, 0).getTime();
    const r = parseTimePhrase("this week", sunday);
    // Expected Monday = Dec 29, 2025 (midnight local)
    const expectedMonday = new Date(2025, 11, 29).getTime();
    expect(r.after).toBe(expectedMonday);
  });

  it("parses 'around month day' and sets a 6-day window centred on that date", () => {
    const r = parseTimePhrase("around january 4", NOW);
    expect(r.after).toBeDefined();
    expect(r.before).toBeDefined();
    expect(r.before! - r.after!).toBe(6 * DAY);
  });

  describe("month-day text that is not a question date", () => {
    it("does not filter a month-day name embedded in a proper noun", () => {
      const query = "What time does the Aug 8 Velmora Cafe open?";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("does not filter a month-day name followed by more than one capitalized word", () => {
      const query = "Where is the Jun 3 Northgate Supply Co warehouse?";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("does not treat 'as of <date>' as a created-on-that-day filter", () => {
      const query = "Where was the Velmora studio lease as of April 15, 2026?";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("does not treat a bare 'as of <date>' as a filter", () => {
      const query = "as of Aug 12, 2026";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("is case-insensitive about 'as of'", () => {
      const query = "As Of August 17, 2024, where did the lease stand?";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("still filters a genuine date elsewhere in a query that also names a month-day place", () => {
      const query = "The Aug 8 Velmora Cafe reopened on September 3";
      expect(parseTimePhrase(query, NOW)).toEqual({
        after: new Date(2026, 8, 3).getTime(),
        before: new Date(2026, 8, 4).getTime(),
        cleanQuery: "The Aug 8 Velmora Cafe reopened",
      });
    });

    it("leaves a street number alone", () => {
      const query = "notes about the 123 Main Street lease";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("leaves 'Route 66' alone", () => {
      const query = "Route 66 roadtrip planning notes";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("leaves a version string alone", () => {
      const query = "release notes for version 4.2.7";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("leaves 'May' used as a person's name alone", () => {
      const query = "May Chen's quarterly report";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });
  });

  // Cross-vendor review (T-0105.3, then T-0105.4) found two rounds of edge cases in the
  // proper-noun/as-of check. Simplified to the safe failure mode: a wrong filter hides the right
  // memory, a missing filter only broadens results. A preposition never rescues a date by
  // itself: "by/until/before/after/since/from" have range meaning this parser doesn't implement,
  // so a date they introduce produces no filter at all, never a same-day window. A bare or
  // "on"-led date is genuine only when nothing follows it, or what follows is a timezone/time
  // expression; any other following text (a name, a description, capitalized or not) means it
  // isn't standing alone as a date.
  describe("review round: safe-failure-mode prepositions and timezones", () => {
    it("keeps a month-day business name with lowercase styling", () => {
      const query = "What time does the May 5 cafe open?";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("keeps a real date followed by a multi-word timezone qualifier", () => {
      const result = parseTimePhrase("What happened on May 5 New York time?", NOW);
      expect(result.after).toBe(new Date(2026, 4, 5).getTime());
      expect(result.before).toBe(new Date(2026, 4, 6).getTime());
    });

    it("never turns 'since <date>' into a same-day window, even with no trailing text", () => {
      const query = "open since Jun 3";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("never turns 'until <date>' into a same-day window, even with a timezone qualifier", () => {
      const query = "closed until Aug 9 Pacific time";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("never turns 'by <date>' into a same-day window (the reported deadline case)", () => {
      const query = "Was the work done by March 3 Paris time?";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("keeps a venue name with no leading article or preposition at all", () => {
      const query = "May 5 Cafe on Main opening hours";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("keeps a venue name even when a preceding 'on' means 'about', not a date anchor", () => {
      const query = "Notes on May 5 Cafe on Main";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("recognizes an ordinal date", () => {
      const result = parseTimePhrase("What happened on May 5th?", NOW);
      expect(result.after).toBe(new Date(2026, 4, 5).getTime());
      expect(result.before).toBe(new Date(2026, 4, 6).getTime());
    });

    it("leaves a month without a day alone", () => {
      const query = "open since May";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("keeps a lowercase business name introduced by an indefinite article", () => {
      const query = "reviewed a dec 2 bakery menu";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("keeps an uppercase business name introduced by an indefinite article", () => {
      const query = "found an Apr 12 Meridian diner receipt";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("does not normalize a nonexistent around-date into another month", () => {
      const query = "notes from around Feb 30";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("does not normalize a nonexistent around-date given as an abbreviation", () => {
      const query = "around Apr 31 plans";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    // Deferred: "as of yesterday" becoming a created-at filter is Track 2 as-of semantics (an
    // as-of read, not a creation-window filter), not this round's fix. Tracked for T2 lane C.
    it.skip("does not turn relative as-of language into a created-at filter", () => {
      const query = "What was true as of yesterday?";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });
  });

  describe("phrasing this parser intentionally does not date-filter yet", () => {
    // "last <weekday>" and a bare "in <month>" are not part of T-0089.2.5's bug (misreading
    // month-day names and "as of" phrasing as filters). Adding either here would also add a new
    // hard filter to real "during <month>" query text in the temporal-during eval category,
    // which is report-only pending Track 2's as-of gate — out of scope for this fix. Both fall
    // through untouched today, same as any other non-temporal query text.
    it("passes 'last Tuesday' through unfiltered", () => {
      const query = "last Tuesday";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });

    it("passes a bare 'in March' through unfiltered", () => {
      const query = "in March";
      expect(parseTimePhrase(query, NOW)).toEqual({ cleanQuery: query });
    });
  });
});
