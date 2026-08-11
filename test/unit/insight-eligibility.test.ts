import { describe, it, expect } from "vitest";
import { isInsightEligible, topicTagsOf } from "../../src/insight/eligibility";

const entry = (over: Partial<{ content: string; tags: string[]; source: string }> = {}) => ({
  content: "A decision about the pricing model, written out at some length so it clears the floor.",
  tags: ["work", "pricing"],
  source: "claude-desktop",
  ...over,
});

describe("isInsightEligible()", () => {
  it("accepts an ordinary human-authored entry", () => {
    expect(isInsightEligible(entry())).toBe(true);
  });

  it("rejects machine-authored entries", () => {
    for (const tag of ["synthesized", "auto-pattern", "auto-insight"]) {
      expect(isInsightEligible(entry({ tags: ["work", tag] }))).toBe(false);
    }
  });

  it("rejects deprecated entries", () => {
    expect(isInsightEligible(entry({ tags: ["work", "status:deprecated"] }))).toBe(false);
  });

  it("rejects entries carrying only system tags", () => {
    expect(isInsightEligible(entry({ tags: ["kind:episodic", "status:canonical"] }))).toBe(false);
  });

  it("rejects integration-mirrored records", () => {
    for (const source of ["git-hook", "email-icloud", "email-gmail"]) {
      expect(isInsightEligible(entry({ source }))).toBe(false);
    }
  });

  it("rejects entries too short to carry an idea", () => {
    expect(isInsightEligible(entry({ content: "Shipped v2." }))).toBe(false);
  });
});

describe("topicTagsOf()", () => {
  it("strips system, bookkeeping and axis tags", () => {
    const topics = topicTagsOf([
      "work", "task", "context", "claude-response",   // axis
      "kind:semantic", "status:canonical",            // system
      "rolled-up", "duplicate-candidate",             // bookkeeping
      "pricing",                                      // the only real topic
    ]);
    expect([...topics]).toEqual(["pricing"]);
  });

  it("is case-insensitive about axis tags", () => {
    expect([...topicTagsOf(["Work", "pricing"])]).toEqual(["pricing"]);
  });
});
