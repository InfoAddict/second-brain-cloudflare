/**
 * Adversary (T-0089.1.1, Task 6): writers to `entries` that the inventory guard never sees.
 * test/unit/entry-write-inventory.test.ts finds writers with templateSpans() + isEntriesWriteSql(); every case
 * below is a real, working D1 write that this pair returns nothing for, so it needs no marker and no version.
 */
import { describe, it, expect } from "vitest";
import * as checkScope from "../../scripts/check-scope.mjs";

// The guard's scanner: writerSpans once trash 5ef2dec (ADV-5 fix) is merged, templateSpans before it.
const spansOf = ((checkScope as any).writerSpans ?? checkScope.templateSpans) as (text: string) => { start: number; end: number }[];
import { isEntriesWriteSql } from "../../src/db/fts-write-guard";

/** Exactly what scanInventory() does per file (writerSpans since trash 5ef2dec; templateSpans before). */
function writersIn(text: string): string[] {
  return spansOf(text)
    .map(s => text.slice(s.start + 1, s.end))
    .filter(sql => isEntriesWriteSql(sql));
}

describe("ADV-5 (MINOR): the write-path inventory guard can be bypassed", () => {
  it("a double-quoted SQL string", () => {
    expect(writersIn(`await env.DB.prepare("UPDATE entries SET content = ? WHERE id = ?").bind(c, id).run();`)).toHaveLength(1);
  });
  it("a single-quoted SQL string", () => {
    expect(writersIn(`await env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();`)).toHaveLength(1);
  });
  it("a table name interpolated into the template", () => {
    expect(writersIn("const T = 'entries';\nawait env.DB.prepare(`UPDATE ${T} SET tags = ? WHERE id = ?`).bind(t, id).run();")).toHaveLength(1);
  });
  it("a verb chosen at runtime by a helper", () => {
    expect(writersIn("const verb = soft ? 'UPDATE' : 'DELETE FROM';\nawait env.DB.prepare(`${verb} entries SET content = ? WHERE id = ?`).run();")).toHaveLength(1);
  });
  it("a writer template nested inside another template's ${...}", () => {
    expect(writersIn("await env.DB.exec(`${fix ? `UPDATE entries SET content = '' WHERE id = 'x'` : ''}`);")).toHaveLength(1);
  });
  it("a second statement in one exec() string", () => {
    expect(writersIn("await env.DB.exec(`UPDATE workspaces SET name = 'a'; UPDATE entries SET content = 'b'`);")).toHaveLength(1);
  });
  // Builder B's residual ADV-5 fix (3a2b8df7, writerSpans): concatenation and join() now fail loud.
  it("R2: a statement split across a string concatenation", () => {
    expect(writersIn(`await env.DB.prepare("UPDATE " + "entries SET content = ? WHERE id = ?").bind(c, id).run();`)).toHaveLength(1);
  });
  it("R2: a statement assembled with join()", () => {
    expect(writersIn(`await env.DB.prepare(["DELETE FROM", "entries", "WHERE id = ?"].join(" ")).bind(id).run();`)).toHaveLength(1);
  });
});
