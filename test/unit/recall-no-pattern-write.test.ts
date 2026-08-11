import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

describe("recall no longer mines patterns", () => {
  it("does not import derivePattern", () => {
    const src = readFileSync(resolve(ROOT, "src/recall/search.ts"), "utf8");
    expect(src).not.toContain("derivePattern");
  });

  it("has no pattern module left to import", () => {
    expect(() => readFileSync(resolve(ROOT, "src/compression/pattern.ts"), "utf8"))
      .toThrow();
  });

  it("leaves auto-pattern in the reserved tag list so old entries stay excluded", () => {
    const src = readFileSync(resolve(ROOT, "src/tags/system.ts"), "utf8");
    expect(src).toContain("auto-pattern");
  });
});
