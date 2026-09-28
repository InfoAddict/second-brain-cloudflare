/**
 * providerName() (public/utils.js) turns a provider id into the brand name a
 * sentence uses ("by the Notion sync", not "by the notion sync"). Its map
 * must not silently miss a registered integration - read as text, the same
 * technique test/unit/history-trash-settings-parity.test.ts uses for a Rust
 * file, since this is a plain JS object with no runtime that imports both
 * sides at once.
 *
 * One-way: every id the registry knows about must be in PROVIDER_NAMES with
 * the same name. PROVIDER_NAMES may have extra entries (github, git-hook,
 * obsidian) for source values that are not a synced integration at all.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Every `id: "..."` paired with the `name: "..."` that follows it, within a
 * short window - true for every provider object literal in these files. */
function idNamePairs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const idRe = /id:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(src))) {
    const id = m[1];
    const after = src.slice(m.index, m.index + 300);
    const nameMatch = after.match(/name:\s*"([^"]+)"/);
    if (nameMatch) out[id] = nameMatch[1];
  }
  return out;
}

function registryProviders(): Record<string, string> {
  return {
    ...idNamePairs(read("src/integrations/index.ts")),
    ...idNamePairs(read("src/integrations/notion.ts")),
  };
}

function providerNamesMap(): Record<string, string> {
  const src = read("public/utils.js");
  const block = src.match(/const PROVIDER_NAMES = \{([^}]*)\}/s)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(?:'([^']+)'|(\w[\w-]*))\s*:\s*'([^']+)'/g)) {
    out[m[1] ?? m[2]] = m[3];
  }
  return out;
}

describe("providerName() covers every registered integration", () => {
  const registry = registryProviders();
  const names = providerNamesMap();

  it("the registry actually has providers to check (a broken reader would pass vacuously)", () => {
    expect(Object.keys(registry).length).toBeGreaterThanOrEqual(6);
  });

  it("every registry id is in PROVIDER_NAMES, with the same name", () => {
    const missing = Object.entries(registry).filter(([id, name]) => names[id] !== name);
    expect(
      missing,
      `PROVIDER_NAMES (public/utils.js) is missing or disagrees with the registry: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });
});
