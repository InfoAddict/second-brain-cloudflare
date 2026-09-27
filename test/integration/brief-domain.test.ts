import { describe, expect, it } from "vitest";
import { computeBrief } from "../../src/brief/compute";
import { resolveEntryAction } from "../../src/memory/actions";
import { readEntryTimeline } from "../../src/memory/history";

describe("shared brief domain", () => {
  it("exposes the computation used by the REST route and MCP", () => {
    expect(typeof computeBrief).toBe("function");
  });
  it("exposes the shared resolution path", () => {
    expect(typeof resolveEntryAction).toBe("function");
  });
  it("exposes the shared entry timeline", () => {
    expect(typeof readEntryTimeline).toBe("function");
  });
});
