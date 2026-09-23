import { describe, it, expect } from "vitest";
import { zonedTimeMs, zonedMidnightMs, zonedMsFromBareIso } from "../../src/when/timezone";

describe("zonedMidnightMs", () => {
  it("is a no-op for UTC", () => {
    expect(zonedMidnightMs(2026, 8, 23, "UTC")).toBe(Date.UTC(2026, 8, 23));
  });

  it("anchors midnight in America/New_York during EDT (UTC-4) four hours later than UTC midnight", () => {
    // 2026-09-23 is in daylight time; midnight Eastern is 04:00 UTC.
    expect(zonedMidnightMs(2026, 8, 23, "America/New_York")).toBe(Date.UTC(2026, 8, 23, 4));
  });

  it("anchors midnight in America/New_York during EST (UTC-5) five hours later than UTC midnight", () => {
    // DST-aware, not a fixed offset: mid-January is standard time.
    expect(zonedMidnightMs(2026, 0, 15, "America/New_York")).toBe(Date.UTC(2026, 0, 15, 5));
  });

  it("anchors midnight in a zone ahead of UTC earlier than UTC midnight", () => {
    // Asia/Tokyo is UTC+9 year-round (no DST): midnight JST is the PREVIOUS
    // UTC day at 15:00.
    expect(zonedMidnightMs(2026, 8, 23, "Asia/Tokyo")).toBe(Date.UTC(2026, 8, 22, 15));
  });
});

describe("zonedTimeMs", () => {
  it("anchors a wall-clock time of day, not just midnight, in the configured zone", () => {
    // 09:00 Eastern (EDT, UTC-4) is 13:00 UTC.
    expect(zonedTimeMs(2026, 5, 15, 9, 0, 0, "America/New_York")).toBe(Date.UTC(2026, 5, 15, 13));
  });
});

describe("zonedMsFromBareIso", () => {
  it("parses a bare date and anchors it in the given zone", () => {
    expect(zonedMsFromBareIso("2026-09-23", "America/New_York")).toBe(Date.UTC(2026, 8, 23, 4));
  });

  it("parses a bare datetime (no offset) and anchors its wall-clock time in the given zone", () => {
    expect(zonedMsFromBareIso("2026-09-23T09:00:00", "America/New_York")).toBe(Date.UTC(2026, 8, 23, 13));
  });

  it("parses a bare datetime without seconds", () => {
    expect(zonedMsFromBareIso("2026-09-23T09:00", "America/New_York")).toBe(Date.UTC(2026, 8, 23, 13));
  });

  it("returns null for a string carrying an explicit offset (not this module's job)", () => {
    expect(zonedMsFromBareIso("2026-09-23T09:00:00Z", "America/New_York")).toBeNull();
    expect(zonedMsFromBareIso("2026-09-23T09:00:00+02:00", "America/New_York")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(zonedMsFromBareIso("not a date", "America/New_York")).toBeNull();
  });
});
