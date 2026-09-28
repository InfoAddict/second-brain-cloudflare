/**
 * R16 (budget auditor, T-0089.2.1): the "replaced by" lookup is one shared SQL fragment,
 * supersededBySql in src/memory/validity.ts. A second hand-written copy is how the workspace-index
 * plan (every returned row walking its whole workspace) spread to four readers, so any statement
 * that returns superseded_by_json must interpolate the helper, and no other file may spell the
 * lookup out.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { templateSpans } from "../../scripts/check-scope.mjs";
import { supersededBySql } from "../../src/memory/validity";

const ROOT = join(import.meta.dirname, "../..");
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}
function literals(): { file: string; sql: string }[] {
  const out: { file: string; sql: string }[] = [];
  for (const path of walk(join(ROOT, "src"))) {
    const text = readFileSync(path, "utf8");
    for (const span of templateSpans(text) as unknown as { start: number; end: number }[]) {
      out.push({ file: relative(ROOT, path), sql: text.slice(span.start + 1, span.end) });
    }
  }
  return out;
}

describe("superseded_by has one definition", () => {
  const all = literals();

  it("every statement returning superseded_by_json interpolates supersededBySql", () => {
    const readers = all.filter(l => /AS superseded_by_json/.test(l.sql));
    expect(readers.length).toBeGreaterThanOrEqual(4);
    expect(readers.filter(l => !/\$\{supersededBySql\(/.test(l.sql)).map(l => l.file)).toEqual([]);
  });

  it("no file other than validity.ts spells out the lookup", () => {
    const copies = all.filter(l => l.file !== "src/memory/validity.ts"
      && /type = 'supersedes'/.test(l.sql) && /COALESCE\(\w+\.valid_from, \w+\.created_at\) = \w+\.valid_until/.test(l.sql));
    expect(copies.map(l => l.file)).toEqual([]);
  });

  it("walks edges first, looks the closer up by primary key, and skips rows that are still open", () => {
    const sql = supersededBySql("entries");
    expect(sql).toMatch(/FROM edges g CROSS JOIN entries s ON s\.id = g\.source_id/);
    expect(sql).toMatch(/^CASE WHEN entries\.valid_until IS NULL THEN NULL ELSE/);
  });
});
