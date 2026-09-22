/**
 * Explicit `when` input validation, shared by MCP remember/append and
 * POST /capture (src/when/input.ts). The caller decided the date; this only
 * checks it parses and is not absurdly far out.
 */
import { describe, it, expect } from "vitest";
import { parseExplicitWhen, WHEN_KIND_VALUES, WHEN_MAX_FUTURE_MS } from "../../src/when/input";

const NOW = Date.UTC(2026, 0, 1);

describe("parseExplicitWhen", () => {
  it("accepts an ISO date and defaults when_kind to wake", () => {
    const result = parseExplicitWhen("2026-06-15", undefined, NOW);
    expect(result.error).toBeUndefined();
    expect(result.value?.at).toBe(Date.parse("2026-06-15"));
    expect(result.value?.kind).toBe("wake");
    expect(result.value?.source).toBe("explicit");
  });

  it("accepts an ISO datetime with an explicit when_kind", () => {
    const result = parseExplicitWhen("2026-06-15T09:00:00Z", "due", NOW);
    expect(result.error).toBeUndefined();
    expect(result.value?.at).toBe(Date.parse("2026-06-15T09:00:00Z"));
    expect(result.value?.kind).toBe("due");
  });

  it.each(["due", "event", "wake"] as const)("accepts when_kind %s", (kind) => {
    const result = parseExplicitWhen("2026-06-15", kind, NOW);
    expect(result.value?.kind).toBe(kind);
  });

  it("rejects an unparseable string", () => {
    const result = parseExplicitWhen("not a date", undefined, NOW);
    expect(result.error).toMatch(/parseable/);
    expect(result.value).toBeUndefined();
  });

  it("rejects an empty string", () => {
    const result = parseExplicitWhen("   ", undefined, NOW);
    expect(result.error).toMatch(/parseable/);
  });

  it("rejects an invalid when_kind", () => {
    const result = parseExplicitWhen("2026-06-15", "someday", NOW);
    expect(result.error).toMatch(/when_kind must be one of/);
  });

  it("rejects a date more than 5 years in the future", () => {
    const tooFar = new Date(NOW + WHEN_MAX_FUTURE_MS + 86400000).toISOString();
    const result = parseExplicitWhen(tooFar, undefined, NOW);
    expect(result.error).toMatch(/5 years/);
  });

  it("accepts a date exactly at the 5-year boundary", () => {
    const atBoundary = new Date(NOW + WHEN_MAX_FUTURE_MS).toISOString();
    const result = parseExplicitWhen(atBoundary, undefined, NOW);
    expect(result.error).toBeUndefined();
  });

  it("accepts a past date — retroactive reminders are not restricted", () => {
    const result = parseExplicitWhen("2020-01-01", undefined, NOW);
    expect(result.error).toBeUndefined();
    expect(result.value?.at).toBe(Date.parse("2020-01-01"));
  });

  it("exposes the three when_kind values", () => {
    expect(WHEN_KIND_VALUES).toEqual(["due", "event", "wake"]);
  });

  describe("Finding 5 — deterministic UTC normalization", () => {
    it("a bare date normalizes to UTC midnight", () => {
      const result = parseExplicitWhen("2026-06-15", undefined, NOW);
      expect(result.value?.at).toBe(Date.UTC(2026, 5, 15));
    });

    it("a bare datetime with no offset is treated as UTC, not runtime-local time", () => {
      const result = parseExplicitWhen("2026-06-15T09:00:00", undefined, NOW);
      expect(result.error).toBeUndefined();
      expect(result.value?.at).toBe(Date.UTC(2026, 5, 15, 9, 0, 0));
    });

    it("an explicit Z is unaffected", () => {
      const result = parseExplicitWhen("2026-06-15T09:00:00Z", undefined, NOW);
      expect(result.value?.at).toBe(Date.UTC(2026, 5, 15, 9, 0, 0));
    });

    it("an explicit offset is honored rather than overridden", () => {
      const result = parseExplicitWhen("2026-06-15T09:00:00+02:00", undefined, NOW);
      expect(result.value?.at).toBe(Date.parse("2026-06-15T09:00:00+02:00"));
      expect(result.value?.at).toBe(Date.UTC(2026, 5, 15, 7, 0, 0));
    });
  });
});
