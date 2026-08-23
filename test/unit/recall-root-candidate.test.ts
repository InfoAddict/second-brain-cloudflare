import { describe, expect, it } from "vitest";
import { localEvidenceOf } from "../../src/recall/root-candidate";

describe("localEvidenceOf", () => {
  it("uses winning chunk metadata instead of an unrelated parent section", () => {
    const match = {
      id: "entry-chunk-2",
      score: 0.8,
      metadata: { parentId: "entry", content: "backend support skills" },
    };
    expect(localEvidenceOf(match, "anniversary recap\nbackend support skills", ["backend"])).toBe(
      "backend support skills",
    );
  });

  it("falls back to a query-relevant parent window when metadata has no content", () => {
    const content = `${"unrelated ".repeat(500)}The issue ledger counted closed items as open.`;
    expect(localEvidenceOf({ id: "entry", score: 0.8 }, content, ["issue", "ledger"])).toContain(
      "issue ledger counted closed items",
    );
  });
});
