import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const readme = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");

describe("README MCP troubleshooting (#223)", () => {
  it("documents lazy MCP tool loading for Claude Code", () => {
    expect(readme).toMatch(/Claude Code says Second Brain is/i);
    expect(readme).toMatch(/lazily/i);
    expect(readme).toMatch(/tool list/i);
  });

  it("tells users to verify with a real recall call", () => {
    expect(readme).toMatch(/Verify with a real tool call/i);
    expect(readme).toMatch(/recall/i);
  });

  it("distinguishes connected from actually unavailable", () => {
    expect(readme).toMatch(/mean the server is down/i);
    expect(readme).toMatch(/when a tool call returns/i);
  });
});
