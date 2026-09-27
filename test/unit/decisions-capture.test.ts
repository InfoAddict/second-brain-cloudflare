/**
 * Decision capture rules (src/decisions/capture.ts): validation, confidence
 * rounding, the review date, and the frozen label. Pure — no D1, no writes.
 */
import { describe, it, expect, vi } from "vitest";
import {
  validateDecisionCapture,
  buildDecisionCapture,
  roundConfidence,
  shortDecision,
  reviewLabel,
  computeReviewAt,
  LEDGER_DECISION_TAG,
  type DecisionCaptureInput,
} from "../../src/decisions/capture";
import { zonedTimeMs } from "../../src/when/timezone";
import { makeTestEnv } from "../helpers/make-env";

const CFG = { reviewDefaultDays: 90, timezone: "UTC" };
const NOW = Date.UTC(2026, 8, 27); // 2026-09-27

describe("roundConfidence", () => {
  it("rounds to the nearest 0.05", () => {
    expect(roundConfidence(0.72)).toEqual({ value: 0.7 });
    expect(roundConfidence(0.73)).toEqual({ value: 0.75 });
  });

  it("clamps to [0.05, 0.95] and names why when it moved, in plain (non-'ledger') words", () => {
    expect(roundConfidence(1)).toEqual({ value: 0.95, reason: "the highest allowed" });
    expect(roundConfidence(0.99)).toEqual({ value: 0.95, reason: "the highest allowed" });
    expect(roundConfidence(0.01)).toEqual({ value: 0.05, reason: "the lowest allowed" });
  });

  it("0 and anything over 1 are errors", () => {
    expect(roundConfidence(0)).toEqual({ error: expect.any(String) });
    expect(roundConfidence(1.5)).toEqual({ error: expect.any(String) });
    expect(roundConfidence(-0.2)).toEqual({ error: expect.any(String) });
  });
});

describe("shortDecision", () => {
  it("cuts the first sentence at 60 characters on a word boundary", () => {
    const content = "Decided to hire Dana for the design lead role because of a strong portfolio; some doubt about team fit.";
    const short = shortDecision(content);
    expect(short.length).toBeLessThanOrEqual(60);
    expect(content.startsWith(short.replace(/[.,;:!?-]+$/, ""))).toBe(true);
    // never cuts mid-word
    const nextChar = content[short.length];
    expect(nextChar === undefined || nextChar === " " || /[.,;:!?-]/.test(nextChar)).toBe(true);
  });

  it("stops at the first sentence, not the whole content", () => {
    expect(shortDecision("We're going with Postgres. It has the best JSON support.")).toBe("We're going with Postgres");
  });

  it("strips trailing punctuation", () => {
    expect(shortDecision("Ship it.")).toBe("Ship it");
  });
});

describe("reviewLabel: 'Review: ' plus the short form", () => {
  it("is 'Review: ' plus the short form", () => {
    expect(reviewLabel("We're going with Postgres.")).toBe("Review: We're going with Postgres");
  });
});

describe("computeReviewAt", () => {
  it("uses review_by when given", () => {
    const result = computeReviewAt({ review_by: "2026-12-01", now: NOW, timezone: "UTC", days: 90 });
    expect("at" in result && result.at).toBe(zonedTimeMs(2026, 11, 1, 0, 0, 0, "UTC"));
  });

  it("falls back to when, then to now + days at 09:00 local", () => {
    const withWhen = computeReviewAt({ when: "2026-11-15", now: NOW, timezone: "UTC", days: 90 });
    expect("at" in withWhen && withWhen.at).toBe(zonedTimeMs(2026, 10, 15, 0, 0, 0, "UTC"));

    const withDefault = computeReviewAt({ now: NOW, timezone: "UTC", days: 90 });
    const expected = zonedTimeMs(2026, 11, 26, 9, 0, 0, "UTC"); // 2026-09-27 + 90 days = 2026-12-26
    expect("at" in withDefault && withDefault.at).toBe(expected);
  });

  it("anchors the default review time at 09:00 local in a non-UTC configured zone", () => {
    const result = computeReviewAt({ now: NOW, timezone: "America/New_York", days: 90 });
    const at = "at" in result ? result.at : NaN;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    }).formatToParts(at);
    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    expect(hour).toBe("09");
    expect(minute).toBe("00");
    // roughly 90 days out, within a day either way of the zone's date-boundary edge.
    const daysOut = (at - NOW) / 86400000;
    expect(daysOut).toBeGreaterThan(88.5);
    expect(daysOut).toBeLessThan(91.5);
  });
});

describe("validateDecisionCapture", () => {
  it("refuses confidence, confidence_source or review_by without decision: true, and says nothing was saved", () => {
    const msg = "confidence and review_by only work with decision: true. Nothing was saved.";
    expect(validateDecisionCapture({ confidence: 0.7 })?.error).toBe(msg);
    expect(validateDecisionCapture({ confidence_source: "stated" })?.error).toBe(msg);
    expect(validateDecisionCapture({ review_by: "2026-12-01" })?.error).toBe(msg);
  });

  it("refuses decision combined with standing, owed_by or owed_to, and says nothing was saved", () => {
    const msg = "A decision can't also be a standing instruction or a commitment. Nothing was saved.";
    expect(validateDecisionCapture({ decision: true, standing: true })?.error).toBe(msg);
    expect(validateDecisionCapture({ decision: true, owed_by: "Priya" })?.error).toBe(msg);
    expect(validateDecisionCapture({ decision: true, owed_to: "Sam" })?.error).toBe(msg);
  });

  it("refuses a decision with both review_by and when, without implying when alone is refused", () => {
    expect(validateDecisionCapture({ decision: true, review_by: "2026-12-01", when: "2026-11-01" })?.error)
      .toBe("Pass the review date as review_by or when, not both. Nothing was saved.");
  });

  it("refuses a when_kind other than due on a decision", () => {
    expect(validateDecisionCapture({ decision: true, when_kind: "wake" })?.error)
      .toBe('A decision\'s review date is always a due date. Leave when_kind out, or use "due". Nothing was saved.');
  });

  it("allows a plain decision, and a decision with when_kind due explicitly", () => {
    expect(validateDecisionCapture({ decision: true })).toBeNull();
    expect(validateDecisionCapture({ decision: true, when_kind: "due" })).toBeNull();
  });

  it("is a no-op for a non-decision capture with none of the decision-only fields", () => {
    expect(validateDecisionCapture({})).toBeNull();
    expect(validateDecisionCapture({ standing: true })).toBeNull();
  });
});

describe("buildDecisionCapture", () => {
  const content = "Decided to hire Dana for the design lead role.";

  it("writes ledger:decision, confidence and confidence-source tags, and the review when_* fields, with source defaulting to inferred", () => {
    const result = buildDecisionCapture({ decision: true, confidence: 0.7 }, content, NOW, CFG);
    if ("error" in result) throw new Error(result.error);
    expect(result.tags).toContain(LEDGER_DECISION_TAG);
    expect(result.tags).toContain("confidence:0.70");
    expect(result.tags).toContain("confidence-source:inferred");
    expect(result.confidence).toEqual({ value: 0.7, source: "inferred" });
    expect(result.when_kind).toBe("due");
    expect(result.when_source).toBe("explicit");
    // Bare short decision, no "Review:" prefix stored (Italian on the Due
    // sheet, 18-copy-deck.md section 5): the ledger:decision tag marks it as
    // a review, and each reader (push, later the dashboard) adds its own
    // localized prefix instead of showing this stored English one unchanged.
    expect(result.when_label).toBe("Decided to hire Dana for the design lead role");
    expect(result.when_label).not.toContain("Review");
  });

  it("marks the source stated when given", () => {
    const result = buildDecisionCapture({ decision: true, confidence: 0.8, confidence_source: "stated" }, content, NOW, CFG);
    if ("error" in result) throw new Error(result.error);
    expect(result.tags).toContain("confidence-source:stated");
    expect(result.confidence?.source).toBe("stated");
  });

  it("carries no confidence tags at all when none is given", () => {
    const result = buildDecisionCapture({ decision: true }, content, NOW, CFG);
    if ("error" in result) throw new Error(result.error);
    expect(result.tags.some((t) => t.startsWith("confidence"))).toBe(false);
    expect(result.confidence).toBeUndefined();
  });

  it("defaults the review date to +90 days at 09:00 UTC when nothing is given", () => {
    const result = buildDecisionCapture({ decision: true }, content, NOW, CFG);
    if ("error" in result) throw new Error(result.error);
    expect(result.when_at).toBe(zonedTimeMs(2026, 11, 26, 9, 0, 0, "UTC"));
  });

  it("surfaces the clamp reason in the returned confidence", () => {
    const result = buildDecisionCapture({ decision: true, confidence: 1 }, content, NOW, CFG);
    if ("error" in result) throw new Error(result.error);
    expect(result.confidence).toEqual({ value: 0.95, source: "inferred", reason: "the highest allowed" });
  });

  it("propagates a validation error and writes nothing", () => {
    const result = buildDecisionCapture({ decision: true, standing: true }, content, NOW, CFG);
    expect("error" in result && result.error).toBe("A decision can't also be a standing instruction or a commitment. Nothing was saved.");
  });

  it("propagates a bad confidence value as an error", () => {
    const result = buildDecisionCapture({ decision: true, confidence: 0 }, content, NOW, CFG);
    expect("error" in result).toBe(true);
  });
});

describe("reviewLabel", () => {
  it("stays the English-prefixed form, used by callers with no i18n of their own (push)", () => {
    expect(reviewLabel("hiring Dana")).toBe("Review: hiring Dana");
  });

  it("is idempotent on an already-short label, so a caller can pass either the full content or the stored bare label", () => {
    const fullContent = "Decided to hire Dana for the design lead role.";
    const shortLabel = shortDecision(fullContent);
    expect(reviewLabel(shortLabel)).toBe(reviewLabel(fullContent));
  });
});

describe("every validation-error path fails before any D1 write or Vectorize call", () => {
  const content = "Decided to hire Dana for the design lead role.";
  const BAD_INPUTS: DecisionCaptureInput[] = [
    { confidence: 0.7 },
    { confidence_source: "stated" },
    { review_by: "2026-12-01" },
    { decision: true, standing: true },
    { decision: true, owed_by: "Priya" },
    { decision: true, owed_to: "Sam" },
    { decision: true, review_by: "2026-12-01", when: "2026-11-01" },
    { decision: true, when_kind: "wake" },
    { decision: true, confidence: 0 },
    { decision: true, confidence: 1.5 },
    { decision: true, confidence: -0.2 },
  ];

  it("every error ends with 'Nothing was saved.' and touches neither env.DB.prepare nor env.VECTORIZE.getByIds", () => {
    const env = makeTestEnv();
    const dbSpy = vi.spyOn(env.DB, "prepare");
    const vectorizeSpy = vi.spyOn(env.VECTORIZE, "getByIds");

    // Mirrors the shape Task 7 wires for real: buildDecisionCapture is the
    // gate, and only a result with no `error` ever reaches a write.
    function simulateCaptureAttempt(input: DecisionCaptureInput) {
      const result = buildDecisionCapture(input, content, NOW, CFG);
      if ("error" in result) return result;
      env.DB.prepare("INSERT INTO entries (id, content, tags) VALUES (?, ?, ?)").bind("id", content, JSON.stringify(result.tags));
      env.VECTORIZE.getByIds(["id"]);
      return result;
    }

    for (const input of BAD_INPUTS) {
      const result = simulateCaptureAttempt(input);
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.error.endsWith("Nothing was saved.")).toBe(true);
    }

    expect(dbSpy).not.toHaveBeenCalled();
    expect(vectorizeSpy).not.toHaveBeenCalled();
  });
});
