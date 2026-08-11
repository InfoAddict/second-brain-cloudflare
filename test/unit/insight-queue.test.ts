import { describe, it, expect } from "vitest";
import { PENDING_INSIGHT_SQL } from "../../src/memory/patterns";
import { isTopicTag } from "../../src/compression/eligibility";

describe("insight review queue", () => {
  it("selects insight entries that have not been ruled on", () => {
    expect(PENDING_INSIGHT_SQL).toContain(`'%"insight"%'`);
    expect(PENDING_INSIGHT_SQL).toContain(`NOT LIKE '%"status:deprecated"%'`);
  });

  it("contains no bind placeholders", () => {
    expect(PENDING_INSIGHT_SQL).not.toContain("?");
  });

  it("treats insight as a bookkeeping tag, never a compression topic", () => {
    expect(isTopicTag("insight")).toBe(false);
    expect(isTopicTag("Insight")).toBe(false);
  });
});
