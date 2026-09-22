/**
 * The free regex date pass (src/when/heuristic.ts), in the style of
 * src/staleness/heuristic.ts: cheap, pure, and deliberately narrow. It only
 * ever claims a date no reasonable reader would dispute — "Friday", "next
 * week", "end of month" are the model's job (src/when/pass.ts), not this
 * one's.
 */
import { describe, it, expect } from "vitest";
import { extractUnambiguousDate } from "../../src/when/heuristic";

const NOW = new Date(2026, 5, 1).getTime(); // June 1, 2026, local midnight

describe("extractUnambiguousDate", () => {
  it("finds an ISO date", () => {
    const at = extractUnambiguousDate("Renewal is due 2026-09-30.", NOW);
    expect(at).toBe(Date.UTC(2026, 8, 30));
  });

  it("finds a 'Month D, YYYY' date", () => {
    const at = extractUnambiguousDate("The lease ends September 30, 2026.", NOW);
    expect(at).toBe(new Date(2026, 8, 30).getTime());
  });

  it("finds an abbreviated 'Mon D YYYY' date", () => {
    const at = extractUnambiguousDate("Renew by Sep 30 2026", NOW);
    expect(at).toBe(new Date(2026, 8, 30).getTime());
  });

  it("finds a bare 'Month D' date and assumes the current year", () => {
    const at = extractUnambiguousDate("Party on September 30", NOW);
    expect(at).toBe(new Date(2026, 8, 30).getTime());
  });

  it("finds an m/d/yyyy date", () => {
    const at = extractUnambiguousDate("Filing deadline: 9/30/2026", NOW);
    expect(at).toBe(new Date(2026, 8, 30).getTime());
  });

  it("handles an ordinal suffix on the day", () => {
    const at = extractUnambiguousDate("Due September 30th, 2026", NOW);
    expect(at).toBe(new Date(2026, 8, 30).getTime());
  });

  it("returns the soonest future date when several appear", () => {
    const at = extractUnambiguousDate(
      "First check-in 2026-07-15, final review 2026-09-30, retro 2026-11-01.",
      NOW,
    );
    expect(at).toBe(Date.UTC(2026, 6, 15));
  });

  it("returns null for content with no date", () => {
    expect(extractUnambiguousDate("Just a regular note about lunch.", NOW)).toBeNull();
  });

  it("returns null for a past ISO date", () => {
    expect(extractUnambiguousDate("Shipped on 2026-01-15.", NOW)).toBeNull();
  });

  it("returns null for a bare month-day that has already passed this year, without rolling to next year", () => {
    // "May 1" is before NOW (June 1, 2026). Rolling it to next year would be
    // exactly the kind of guess this pass is not supposed to make.
    expect(extractUnambiguousDate("We discussed this back on May 1.", NOW)).toBeNull();
  });

  it("does not mistake a version number for a date", () => {
    expect(extractUnambiguousDate("Shipped worker 3.4.0 today.", NOW)).toBeNull();
  });

  it("does not match a past date range like 'July 25-26' from a prior year", () => {
    expect(extractUnambiguousDate("The offsite was July 25-26, 2025.", NOW)).toBeNull();
  });

  it("ignores an invalid calendar date (February 30)", () => {
    expect(extractUnambiguousDate("Due February 30, 2026.", NOW)).toBeNull();
  });

  it("ignores an out-of-range slash date", () => {
    expect(extractUnambiguousDate("Ratio was 14/30/2026 in the report.", NOW)).toBeNull();
  });

  it("does not match a 2-digit year slash date (ambiguous)", () => {
    expect(extractUnambiguousDate("Filed 9/30/26 in the old system.", NOW)).toBeNull();
  });

  it("treats a date exactly at `now` as not future", () => {
    expect(extractUnambiguousDate("Meet at 2026-06-01.", NOW)).toBeNull();
  });

  it("finds a date one day in the future", () => {
    const at = extractUnambiguousDate("Meet at 2026-06-02.", NOW);
    expect(at).toBe(Date.UTC(2026, 5, 2));
  });
});
