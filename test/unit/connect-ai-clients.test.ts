import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function readScript(rel: string) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("connect-ai-clients scripts", () => {
  const sh = readScript("scripts/connect-ai-clients.sh");
  const ps1 = readScript("scripts/connect-ai-clients.ps1");

  for (const [label, text] of [
    ["bash", sh],
    ["powershell", ps1],
  ] as const) {
    it(`${label}: uses second-brain instruction markers`, () => {
      expect(text).toContain("second-brain:instructions:start");
      expect(text).toContain("second-brain:instructions:end");
    });

    it(`${label}: appends CLAUDE_INSTRUCTIONS.md`, () => {
      expect(text).toContain("AI_Instructions/CLAUDE_INSTRUCTIONS.md");
    });
  }

  it("powershell appends CODEX_INSTRUCTIONS.md", () => {
    expect(ps1).toContain("AI_Instructions/CODEX_INSTRUCTIONS.md");
  });

  it("bash appends CODEX_INSTRUCTIONS.md", () => {
    expect(sh).toContain("AI_Instructions/CODEX_INSTRUCTIONS.md");
  });
});
