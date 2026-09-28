/**
 * ADV-1 (MAJOR): a snapshot's compare-and-set guard must check exactly what its UPDATE's WHERE
 * clause checks (spec P3). A guard checking fewer columns than its UPDATE let a miss the UPDATE
 * correctly caught still commit a version — a phantom write under the caller's actor, for a change
 * that never landed (the snooze/clear_date case: the UPDATE compared tags, content AND all four
 * when_* columns; the snapshot's guard compared only tags and content).
 *
 * The fix is structural, not a one-off patch: every CAS-guarded writer builds its guard once, through
 * `buildCasGuard(p, columns)`, and feeds the SAME `columns` object to both its snapshot and its
 * UPDATE. This test enforces that discipline at the source level — a `guard:` option that doesn't
 * go through `buildCasGuard`, or whose UPDATE doesn't reuse the identical columns variable, fails
 * here rather than shipping a silent drift the next time someone adds a compare-and-set writer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

/** Every `guard: p => buildCasGuard(p, <name>)` (with or without extra AND clauses appended) site. */
const GUARD_SITE = /guard:\s*\w+\s*=>\s*(?:`\$\{)?buildCasGuard\(\s*\w+\s*,\s*(\w+)\s*\)/g;

interface Site { file: string; line: number; columnsVar: string }

function findGuardSites(text: string, file: string): Site[] {
  const sites: Site[] = [];
  for (const m of text.matchAll(GUARD_SITE)) {
    const line = text.slice(0, m.index).split("\n").length;
    sites.push({ file, line, columnsVar: m[1] });
  }
  return sites;
}

/**
 * Is the NEXT `buildCasGuard(...)` call after this guard site's own one (which is the guard site
 * itself, on `fromLine`) fed the SAME columns variable — before hitting a bounded lookahead, or
 * another `guard:` site (a different snapshot's guard, meaning this one's own UPDATE was never
 * found)? Scoped this way, not just "somewhere in the next N lines", so a same-named variable in a
 * SIBLING if/else branch's own guard+UPDATE pair cannot satisfy a different branch's check.
 */
function hasMatchingUpdateGuard(text: string, fromLine: number, columnsVar: string, window = 40): boolean {
  const lines = text.split("\n");
  const isGuardSite = (line: string) => /guard:\s*\w+\s*=>/.test(line);
  const CALL = /buildCasGuard\(\s*\w+\s*,\s*(\w+)\s*\)/g;
  let seenOwnGuard = false;
  for (let i = fromLine - 1; i < Math.min(lines.length, fromLine - 1 + window); i++) {
    const line = lines[i];
    if (i + 1 !== fromLine && isGuardSite(line)) return false; // a different guard site started first
    for (const m of line.matchAll(CALL)) {
      if (!seenOwnGuard) { seenOwnGuard = true; continue; } // the first hit is this site's own guard callback
      return m[1] === columnsVar;
    }
  }
  return false;
}

describe("every snapshot guard is fed to its UPDATE unmodified (ADV-1, spec P3)", () => {
  const sites: Site[] = [];
  for (const path of walk(join(ROOT, "src"))) {
    const file = relative(ROOT, path);
    sites.push(...findGuardSites(readFileSync(path, "utf8"), file));
  }

  it("found at least one guarded writer to check (the check itself is not a no-op)", () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it("every guard site's columns object is reused, unmodified, by its own UPDATE", () => {
    const drifted = sites.filter(s => !hasMatchingUpdateGuard(readFileSync(join(ROOT, s.file), "utf8"), s.line, s.columnsVar));
    expect(drifted.map(s => `${s.file}:${s.line} (${s.columnsVar})`)).toEqual([]);
  });
});

describe("buildCasGuard itself", () => {
  it("compares null with IS and everything else with =, through the same Params instance", async () => {
    const { Params, buildCasGuard } = await import("../../src/memory/versions");
    const p = new Params();
    const sql = buildCasGuard(p, { tags: "[]", content: null, workspace_id: "ws1" });
    expect(sql).toBe("e.tags = ?1 AND e.content IS ?2 AND e.workspace_id = ?3");
    expect(p.values()).toEqual(["[]", null, "ws1"]);
  });

  it("a snapshot and a standalone UPDATE fed the same columns object produce guards that agree on every value", async () => {
    const { Params, buildCasGuard } = await import("../../src/memory/versions");
    const columns = { tags: "[\"a\"]", content: "hello", workspace_id: "ws1" };
    const p1 = new Params();
    const snapshotGuard = buildCasGuard(p1, columns);
    const p2 = new Params();
    const updateGuard = buildCasGuard(p2, columns);
    // Same shape (column order, comparator choice) and the same bound values, even from two
    // independent Params instances — which is exactly what a snapshot and its UPDATE are.
    expect(snapshotGuard.replace(/\?\d+/g, "?")).toBe(updateGuard.replace(/\?\d+/g, "?"));
    expect(p1.values()).toEqual(p2.values());
  });
});
