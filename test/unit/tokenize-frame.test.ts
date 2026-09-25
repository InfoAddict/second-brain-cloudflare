import { describe, expect, it } from "vitest";
import { tokenizeQuery } from "../../src/text/tokenize";

describe("tokenizeQuery: the scaffolding an agent wraps around a subject", () => {
  it("keeps the subject terms and drops the request words", () => {
    const tokens = tokenizeQuery("User wants to fix a bug in the capture flow — what have we tried before?");
    for (const term of ["fix", "bug", "capture", "flow"]) expect(tokens).toContain(term);
    for (const frame of ["user", "wants", "tried", "have"]) expect(tokens).not.toContain(frame);
  });

  it("reduces the named shapes to the name", () => {
    expect(tokenizeQuery("Tell me all about courtney")).toEqual(["all", "courtney"]);
    expect(tokenizeQuery("User wants to prepare for a meeting with Courtney — what should I know about her?")).toEqual(["prepare", "meeting", "courtney", "her"]);
    expect(tokenizeQuery("help me find the reranker decision")).toEqual(["reranker", "decision"]);
  });

  it("reduces the CLAUDE.md templates to their subject", () => {
    expect(tokenizeQuery("User is about to use Kobrelune — have I recommended this before or has it been done?")).toEqual(["use", "kobrelune", "before"]);
  });

  it("still searches for the words when they are all the query has", () => {
    expect(tokenizeQuery("help")).toEqual(["help"]);
    expect(tokenizeQuery("user wants")).toEqual(["user", "wants"]);
  });

  it("keeps a word that is also a constraint, such as \"before\" in a question about the order of events", () => {
    expect(tokenizeQuery("why did I stay home before the marathon")).toEqual(["stay", "home", "before", "marathon"]);
  });

  it("leaves queries without scaffolding exactly as they were", () => {
    expect(tokenizeQuery("paseo heartbeat schedule")).toEqual(["paseo", "heartbeat", "schedule"]);
    expect(tokenizeQuery("gatewright")).toEqual(["gatewright"]);
  });
});
