import { describe, it, expect } from "vitest";
import { parseTimePhrase } from "../../src/text/temporal";

const NOW = new Date("2026-05-20T12:00:00.000Z").getTime();
const DAY = 86400000;

describe("parseTimePhrase", () => {
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
});
