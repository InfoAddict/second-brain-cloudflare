import { describe, it, expect } from "vitest";
import { PENDING_INSIGHT_SQL } from "../../src/memory/patterns";
import { isTopicTag } from "../../src/compression/eligibility";

describe("insight review queue", () => {
  it("selects auto-insight entries that have not been ruled on", () => {
    expect(PENDING_INSIGHT_SQL).toContain(`'%"auto-insight"%'`);
    expect(PENDING_INSIGHT_SQL).toContain(`NOT LIKE '%"status:deprecated"%'`);
  });

  it("contains no bind placeholders", () => {
    expect(PENDING_INSIGHT_SQL).not.toContain("?");
  });

  it("treats auto-insight as a bookkeeping tag, never a compression topic", () => {
    expect(isTopicTag("auto-insight")).toBe(false);
    expect(isTopicTag("Auto-Insight")).toBe(false);
  });
});
