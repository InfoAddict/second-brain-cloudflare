/** Track 2 Task A2 (T-0089.2.1): the validity date grammar (spec 14 5.4, P5). */
import { describe, it, expect } from "vitest";
import { parseValidityDate } from "../../src/memory/validity";

const NOW = Date.UTC(2026, 8, 27, 15, 0, 0); // Sep 27 2026, 15:00 UTC
const ok = (raw: string, bound: "start" | "end", tz = "UTC", now = NOW) => {
  const r = parseValidityDate(raw, now, tz, bound);
  if (typeof r !== "number") throw new Error(`refused: ${r.error}`);
  return r;
};

describe("parseValidityDate", () => {
  it("a year starts on Jan 1 and, as an as-of, ends on Dec 31", () => {
    expect(ok("2020", "start")).toBe(Date.UTC(2020, 0, 1));
    expect(ok("2020", "end")).toBe(Date.UTC(2021, 0, 1) - 1);
  });

  it("a month starts on its first day and, as an as-of, ends on its last", () => {
    expect(ok("2026-06", "start")).toBe(Date.UTC(2026, 5, 1));
    expect(ok("2026-06", "end")).toBe(Date.UTC(2026, 6, 1) - 1);
    expect(ok("2024-02", "end")).toBe(Date.UTC(2024, 2, 1) - 1); // leap year
  });

  it("a day starts at midnight and, as an as-of, includes the whole day", () => {
    expect(ok("2026-06-15", "start")).toBe(Date.UTC(2026, 5, 15));
    expect(ok("2026-06-15", "end")).toBe(Date.UTC(2026, 5, 16) - 1);
  });

  it("an ISO datetime with an offset is exact", () => {
    expect(ok("2026-06-15T10:30:00Z", "start")).toBe(Date.UTC(2026, 5, 15, 10, 30));
    expect(ok("2026-06-15T10:30:00+02:00", "end")).toBe(Date.UTC(2026, 5, 15, 8, 30));
  });

  it("dates are read in the brain's TIMEZONE, including at a UTC day boundary", () => {
    // 2026-06-15 in Los Angeles (PDT, UTC-7) starts at 07:00 UTC.
    expect(ok("2026-06-15", "start", "America/Los_Angeles")).toBe(Date.UTC(2026, 5, 15, 7));
    expect(ok("2026-06-15", "end", "America/Los_Angeles")).toBe(Date.UTC(2026, 5, 16, 7) - 1);
    // At 03:00 UTC on Sep 28 it is still Sep 27 in Los Angeles: "today" there is Sep 27, and Sep 28 is the future.
    const lateEvening = Date.UTC(2026, 8, 28, 3);
    expect(parseValidityDate("2026-09-28", lateEvening, "America/Los_Angeles", "start")).toEqual({ error: expect.stringContaining("future") });
    expect(ok("2026-09-27", "start", "America/Los_Angeles", lateEvening)).toBe(Date.UTC(2026, 8, 27, 7));
  });

  it("future dates are refused with the when hint", () => {
    const r = parseValidityDate("2026-09-28", NOW, "UTC", "start");
    expect(r).toEqual({ error: "That date is in the future. Use when for plans and deadlines; valid dates are for what has already happened." });
    expect(parseValidityDate("2027", NOW, "UTC", "start")).toEqual({ error: expect.any(String) });
    expect(parseValidityDate("2026-09-28T00:30:00Z", NOW, "UTC", "start")).toEqual({ error: expect.any(String) });
    expect(ok("2026-09-27T16:00:00Z", "start")).toBe(Date.UTC(2026, 8, 27, 16)); // later today is not the future (P5: the end of today)
  });

  it("today is allowed, and an as-of for the current month or year ends at the end of today", () => {
    expect(ok("2026-09-27", "start")).toBe(Date.UTC(2026, 8, 27));
    expect(ok("2026-09-27", "end")).toBe(Date.UTC(2026, 8, 28) - 1);
    expect(ok("2026-09", "end")).toBe(Date.UTC(2026, 8, 28) - 1);
    expect(ok("2026", "end")).toBe(Date.UTC(2026, 8, 28) - 1);
  });

  it("garbage is refused", () => {
    for (const raw of ["", "  ", "last june", "2026-13", "2026-02-30", "20", "2026-6", "June 2026", "2026-06-15T25:00:00Z"]) {
      expect(parseValidityDate(raw, NOW, "UTC", "start"), raw).toEqual({ error: expect.any(String) });
    }
  });

  it("surrounding whitespace is ignored", () => {
    expect(ok(" 2026-06 ", "start")).toBe(Date.UTC(2026, 5, 1));
  });
});
