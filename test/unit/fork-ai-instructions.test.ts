import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSISTANT_TAGS, AXIS_TAGS } from "../../src/insight/eligibility";

const instructions = (name: string) =>
  readFileSync(`AI_Instructions/${name}`, "utf8");

describe("fork AI instruction invariants", () => {
  it("keeps volatility guidance in every agent template", () => {
    expect(instructions("CLAUDE_INSTRUCTIONS.md")).toMatch(/Volatility.*remember.*append.*update/is);
    expect(instructions("CODEX_INSTRUCTIONS.md")).toMatch(/Volatility.*remember.*append.*update/is);
    expect(instructions("CURSOR_INSTRUCTIONS.md")).toMatch(/Volatility.*remember.*append.*update/is);
    expect(instructions("CHATGPT_INSTRUCTIONS.md")).toMatch(/Volatility.*remember\/append\/update/is);
  });

  it("uses and classifies the ChatGPT-specific response tag", () => {
    const chatgpt = instructions("CHATGPT_INSTRUCTIONS.md");
    expect(chatgpt).toContain("chatgpt-response");
    expect(chatgpt).not.toContain("claude-response");
    expect(AXIS_TAGS.has("chatgpt-response")).toBe(true);
    expect(ASSISTANT_TAGS.has("chatgpt-response")).toBe(true);
  });
});
