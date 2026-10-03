/**
 * Cross-validation and commitment tag-building shared by MCP remember and REST
 * /capture (Design 2.1 point 1, 4.1, 5.1). Decision's own field rules live in
 * src/decisions/capture.ts (validateDecisionCapture); this module adds the
 * standing- and commitment-primary directions of the same three-way refusal,
 * and composes owed_by/owed_to into tags.
 */
import { describe, expect, it } from "vitest";
import { buildCommitmentTags, validateT7Capture } from "../../src/capture/t7-capture";

describe("validateT7Capture", () => {
  it("passes with nothing set", () => {
    expect(validateT7Capture({})).toBeNull();
  });

  it("passes with exactly one of standing, decision, owed_by, owed_to", () => {
    expect(validateT7Capture({ standing: true })).toBeNull();
    expect(validateT7Capture({ decision: true })).toBeNull();
    expect(validateT7Capture({ owed_by: "Priya" })).toBeNull();
    expect(validateT7Capture({ owed_to: "Sam" })).toBeNull();
  });

  it("refuses standing combined with owed_by or owed_to", () => {
    expect(validateT7Capture({ standing: true, owed_by: "Priya" }))
      .toEqual({ error: "A standing instruction can't also be a decision or a commitment. Nothing was saved." });
    expect(validateT7Capture({ standing: true, owed_to: "Sam" }))
      .toEqual({ error: "A standing instruction can't also be a decision or a commitment. Nothing was saved." });
  });

  it("refuses a decision combined with standing or a commitment (decision's own message wins)", () => {
    expect(validateT7Capture({ decision: true, standing: true }))
      .toEqual({ error: "A decision can't also be a standing instruction or a commitment. Nothing was saved." });
    expect(validateT7Capture({ decision: true, owed_by: "Priya" }))
      .toEqual({ error: "A decision can't also be a standing instruction or a commitment. Nothing was saved." });
  });

  it("refuses owed_by and owed_to both given", () => {
    expect(validateT7Capture({ owed_by: "Priya", owed_to: "Sam" }))
      .toEqual({ error: "Use owed_by or owed_to, not both. Nothing was saved." });
  });

  it("refuses a commitment combined with decision or standing", () => {
    expect(validateT7Capture({ owed_by: "Priya", decision: true }))
      .toEqual({ error: "A decision can't also be a standing instruction or a commitment. Nothing was saved." });
    expect(validateT7Capture({ owed_to: "Sam", standing: true }))
      .toEqual({ error: "A standing instruction can't also be a decision or a commitment. Nothing was saved." });
  });

  it("passes through decision's own field-only validation (confidence without decision:true)", () => {
    expect(validateT7Capture({ confidence: 0.7 }))
      .toEqual({ error: "confidence and review_by only work with decision: true. Nothing was saved." });
  });
});

describe("buildCommitmentTags", () => {
  it("owed_by gives task, owed-to-me and counterparty", () => {
    const r = buildCommitmentTags({ owed_by: "Priya" });
    expect(r.tags.sort()).toEqual(["counterparty:priya", "owed-to-me", "task"].sort());
    expect(r.direction).toBe("in");
    expect(r.counterpartyLabel).toBe("Priya");
  });

  it("owed_to gives task and counterparty, no owed-to-me", () => {
    const r = buildCommitmentTags({ owed_to: "Sam" });
    expect(r.tags.sort()).toEqual(["counterparty:sam", "task"].sort());
    expect(r.direction).toBe("out");
    expect(r.counterpartyLabel).toBe("Sam");
  });

  it("a name that yields an empty slug gets task/owed-to-me only, and reply notes it", () => {
    const r = buildCommitmentTags({ owed_by: "!!!" });
    expect(r.tags.sort()).toEqual(["owed-to-me", "task"].sort());
    expect(r.counterpartyLabel).toBeUndefined();
    expect(r.slugDropped).toBe(true);
  });
});
