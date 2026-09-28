import { describe, expect, it } from "vitest";
import { buildOutcomeUpdate, isLedgerDecision, outcomeNoteText } from "../../src/decisions/outcome";

const CFG = { reviewDefaultDays: 90, timezone: "UTC" };
const CONTENT = "Decided to hire Dana for the design lead role; strong portfolio, some doubt about team fit.";

describe("isLedgerDecision", () => {
  it("true only when ledger:decision is present", () => {
    expect(isLedgerDecision(["ledger:decision", "work"])).toBe(true);
    expect(isLedgerDecision(["work"])).toBe(false);
  });
});

describe("buildOutcomeUpdate", () => {
  it("right clears outcome/rearms tags, adds outcome:right, clears when_*, with a reply naming the decision", () => {
    const u = buildOutcomeUpdate(["ledger:decision", "confidence:0.70"], "right", CONTENT, 0, CFG);
    expect(u.nextTags).toEqual(["ledger:decision", "confidence:0.70", "outcome:right"]);
    expect(u.nextWhen).toEqual({ when_at: null, when_kind: null, when_source: "cleared" });
    expect(u.reply).toBe("Recorded: Decided to hire Dana for the design lead role; strong went right. Undo is available.");
  });

  it("a second outcome replaces the first (drops the old outcome tag)", () => {
    const u = buildOutcomeUpdate(["ledger:decision", "outcome:right"], "wrong", CONTENT, 0, CFG);
    expect(u.nextTags).toEqual(["ledger:decision", "outcome:wrong"]);
  });

  it("mixed works the same way as right/wrong", () => {
    const u = buildOutcomeUpdate(["ledger:decision"], "mixed", CONTENT, 0, CFG);
    expect(u.nextTags).toContain("outcome:mixed");
    expect(u.reply).toContain("went mixed");
  });

  it("unknown re-arms +90 days and review-rearms:1 on the first call", () => {
    const now = Date.UTC(2026, 8, 27);
    const u = buildOutcomeUpdate(["ledger:decision"], "unknown", CONTENT, now, CFG);
    expect(u.nextTags).toEqual(["ledger:decision", "outcome:unknown", "review-rearms:1"]);
    expect(u.nextWhen).toEqual({ when_at: now + 90 * 86400000, when_kind: "due", when_source: "explicit" });
    expect(u.reply).toMatch(/^OK, I'll ask again around .+\.$/);
    expect(u.reply).not.toContain("Undo is available");
  });

  it("unknown re-arms to review-rearms:2 on the second call", () => {
    const u = buildOutcomeUpdate(["ledger:decision", "outcome:unknown", "review-rearms:1"], "unknown", CONTENT, 0, CFG);
    expect(u.nextTags).toEqual(["ledger:decision", "outcome:unknown", "review-rearms:2"]);
    expect(u.nextWhen.when_at).not.toBeNull();
  });

  it("unknown clears when_* with no more rearms on the third call", () => {
    const u = buildOutcomeUpdate(["ledger:decision", "outcome:unknown", "review-rearms:2"], "unknown", CONTENT, 0, CFG);
    expect(u.nextTags).toEqual(["ledger:decision", "outcome:unknown"]);
    expect(u.nextWhen).toEqual({ when_at: null, when_kind: null, when_source: "cleared" });
    expect(u.reply).toBe("OK, no more reviews for this one.");
  });
});

describe("outcomeNoteText", () => {
  it("formats the dated outcome line", () => {
    const now = Date.UTC(2026, 8, 27);
    expect(outcomeNoteText("right", "Shipped the redesign early.", now))
      .toBe("Outcome (2026-09-27): right. Shipped the redesign early.");
  });
});
