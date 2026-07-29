import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  START_MARKER,
  END_MARKER,
  SENTINEL_PHRASE,
  applyInstructionBlock,
} from "../../scripts/instruction-block.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

function readScript(rel: string) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

function readInstructions(name: string) {
  return readFileSync(resolve(ROOT, "AI_Instructions", name), "utf8");
}

function countOccurrences(text: string, needle: string) {
  return text.split(needle).length - 1;
}

describe("instruction-block apply logic", () => {
  const newBody = readInstructions("CLAUDE_INSTRUCTIONS.md");

  it("appends a marked block to an empty file", () => {
    const { content, action } = applyInstructionBlock("", newBody);
    expect(action).toBe("appended");
    expect(content).toContain(START_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain("MCP availability");
    expect(countOccurrences(content, START_MARKER)).toBe(1);
  });

  it("replaces an existing marked block with new content", () => {
    const oldBody = "OLD RULE: tell me immediately if unavailable";
    const existing = [
      "# My notes",
      "",
      START_MARKER,
      oldBody,
      END_MARKER,
      "",
    ].join("\n");

    const { content, action } = applyInstructionBlock(existing, newBody);
    expect(action).toBe("updated");
    expect(content).toContain("MCP availability");
    expect(content).not.toContain(oldBody);
    expect(countOccurrences(content, START_MARKER)).toBe(1);
    expect(countOccurrences(content, END_MARKER)).toBe(1);
    expect(content.startsWith("# My notes")).toBe(true);
  });

  it("replaces an existing marked block with CRLF line endings", () => {
    const oldBody = "OLD RULE: tell me immediately if unavailable";
    const existing = [
      "# My notes",
      "",
      START_MARKER,
      oldBody,
      END_MARKER,
      "",
      "Notes after the block",
    ].join("\r\n");

    const { content, action } = applyInstructionBlock(existing, newBody);
    expect(action).toBe("updated");
    expect(content).toContain("MCP availability");
    expect(content).not.toContain(oldBody);
    expect(content).toContain("Notes after the block");
    expect(countOccurrences(content, START_MARKER)).toBe(1);
  });

  it("replaces legacy sentinel-only installs without duplicating the block", () => {
    const existing = [
      "# Claude",
      "",
      SENTINEL_PHRASE,
      "If the second brain MCP tools are unavailable, tell me immediately.",
      "",
      "More personal notes after the old block",
    ].join("\n");

    const { content, action } = applyInstructionBlock(existing, newBody);
    expect(action).toBe("updated-legacy");
    expect(content).toContain("MCP availability");
    expect(content).not.toContain("tell me immediately");
    expect(content).not.toContain("More personal notes after the old block");
    expect(countOccurrences(content, START_MARKER)).toBe(1);
    expect(content.startsWith("# Claude")).toBe(true);
  });
});

describe("connect-ai-clients scripts", () => {
  const sh = readScript("scripts/connect-ai-clients.sh");
  const ps1 = readScript("scripts/connect-ai-clients.ps1");

  for (const [label, text] of [
    ["bash", sh],
    ["powershell", ps1],
  ] as const) {
    it(`${label}: delegates instruction updates to instruction-block.mjs`, () => {
      expect(text).toContain("instruction-block.mjs");
      expect(text).not.toMatch(/Already configured.*skipping/i);
      expect(text).not.toMatch(/Looks like you already pasted these instructions/i);
    });

    it(`${label}: references CLAUDE_INSTRUCTIONS.md`, () => {
      expect(text).toContain("AI_Instructions/CLAUDE_INSTRUCTIONS.md");
    });
  }

  it("powershell references CODEX_INSTRUCTIONS.md", () => {
    expect(ps1).toContain("AI_Instructions/CODEX_INSTRUCTIONS.md");
  });

  it("bash references CODEX_INSTRUCTIONS.md", () => {
    expect(sh).toContain("AI_Instructions/CODEX_INSTRUCTIONS.md");
  });
});
