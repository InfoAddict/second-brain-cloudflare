/**
 * Adversary reproduction ADV-5 (range bb5377f..5c25183, ported from adv/t1-versions@258a932
 * test/unit/adv-entry-write-inventory-bypass.test.ts). test/unit/entry-write-inventory.test.ts
 * finds writers with writerSpans() + isEntriesWriteSql(); every case below is a real, working
 * D1 write that this pair missed entirely, so it needed no marker and no version.
 */
import { describe, it, expect } from "vitest";
import { writerSpans } from "../../scripts/check-scope.mjs";
import { isEntriesWriteSql } from "../../src/db/fts-write-guard";

/** Exactly what scanInventory() does per file. */
function writersIn(text: string): string[] {
  return (writerSpans(text) as { start: number; end: number }[])
    .map(s => text.slice(s.start + 1, s.end))
    .filter(sql => isEntriesWriteSql(sql));
}

describe("ADV-5: the write-path inventory guard can be bypassed", () => {
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
});
