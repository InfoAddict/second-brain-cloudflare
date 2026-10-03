/** Track 2 (T-0089.2.4): the sentences retraction entry points append to their replies (spec 14 5.9). */
import { describe, it, expect } from "vitest";
import { NO_VALIDITY_CHANGE, validityReplySuffix } from "../../src/memory/validity";

const one = { id: "y", preview: "Lives in Denver" };
describe("validityReplySuffix", () => {
  it("says nothing when nothing changed", () => {
    expect(validityReplySuffix(NO_VALIDITY_CHANGE, "x", "status")).toBe("");
  });
  it("names one restored memory, with the forget wording for forget", () => {
    const v = { ...NO_VALIDITY_CHANGE, restored: [one] };
    expect(validityReplySuffix(v, "x", "status")).toBe(` Memory y ("Lives in Denver") is current again.`);
    expect(validityReplySuffix(v, "x", "forget")).toBe(" The older memory y is current again.");
  });
  it("counts several restored and re-closed memories", () => {
    expect(validityReplySuffix({ ...NO_VALIDITY_CHANGE, restored: [one, { id: "z", preview: "" }] }, "x", "status"))
      .toBe(" 2 older memories are current again: y, z.");
    expect(validityReplySuffix({ ...NO_VALIDITY_CHANGE, reclosed: [one] }, "x", "undo")).toBe(" Memory y is replaced by x again.");
    expect(validityReplySuffix({ ...NO_VALIDITY_CHANGE, reclosed: [one, { id: "z", preview: "" }] }, "x", "undo")).toBe(" Memories y, z are replaced by x again.");
  });
  it("says how many dependents were flagged", () => {
    expect(validityReplySuffix({ ...NO_VALIDITY_CHANGE, flagged: 1 }, "x", "status")).toBe(" 1 memory built on it was flagged for a check.");
    expect(validityReplySuffix({ ...NO_VALIDITY_CHANGE, flagged: 3 }, "x", "status")).toBe(" 3 memories built on it were flagged for a check.");
  });
  it("never uses an em dash", () => {
    const all = validityReplySuffix({ restored: [one, one], reclosed: [one, one], flagged: 2, unflagged: 1 }, "x", "forget");
    expect(all).not.toMatch(/—/);
  });
});
