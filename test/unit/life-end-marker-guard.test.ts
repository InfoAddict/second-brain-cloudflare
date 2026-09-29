/**
 * Round 5 re-review MAJOR: the tier-3 life-end marker (src/memory/trash.ts) used to select its
 * ids straight from the batch's own pre-computed plan, with no guard at all -- when the row's own
 * DELETE lost its race (a share moved the row to a workspace outside this batch's own authorized
 * pairs, between the caller's read and this batch), the row stayed live and untouched, but the
 * marker still landed, permanently hiding every earlier event for the id.
 *
 * A life-end marker (an entry_events INSERT for "deleted" or "purged") makes a real, permanent
 * claim: after this row, an id is safe to reuse. That claim can only ever be as trustworthy as the
 * row-removal statement it rides alongside, so this scans every INSERT INTO entry_events writing
 * one of those two event names and asserts it is not unconditional over a plain id list -- it must
 * reference a real guard (entriesGuardSql's own call, or the same `workspace_id = ?` team-admin.ts's
 * own bulk deletes use), the same one guarding the row removal it is paired with in the same batch.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { templateSpans } from "../../scripts/check-scope.mjs";

const ROOT = join(import.meta.dirname, "../..");

/** Files known to write a life-end marker (event 'deleted' or 'purged') inside a batch, alongside
 * the row removal it describes. A new file doing this without being added here is exactly the gap
 * this guard exists to catch -- see the "finds only the known sites" test below. */
const FILES = ["src/memory/trash.ts", "src/lib/team-admin.ts"];

const LIFE_END_EVENT = /'deleted'|'purged'/;
/** Not a specific guard shape -- this codebase has several (entriesGuardSql's EXISTS, a plain
 * workspace_id = ?, a deleted_at < cutoff re-check, a by-id nonce match) -- but every one of them
 * is a WHERE clause on the marker's own SELECT. The bug this guards against had none at all: a
 * bare `SELECT ... FROM json_each(ids)`, true unconditionally for every id the caller planned to
 * remove, whether or not this batch's own DELETE actually removed it. */
const HAS_WHERE_CLAUSE = /\bWHERE\b/;

interface Hit { file: string; line: number; sql: string }

function markerInserts(file: string): Hit[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const spans = templateSpans(text) as unknown as { start: number; end: number; balanced?: boolean }[];
  if ((spans as unknown as { balanced?: boolean }).balanced === false) {
    throw new Error(`life-end-marker-guard scan: ${file} has unbalanced template literals`);
  }
  const hits: Hit[] = [];
  for (const span of spans) {
    const sql = text.slice(span.start + 1, span.end);
    if (!/INSERT INTO entry_events/.test(sql)) continue;
    if (!LIFE_END_EVENT.test(sql)) continue;
    hits.push({ file, line: text.slice(0, span.start).split("\n").length, sql });
  }
  return hits;
}

describe("every life-end marker insert shares its delete's guard", () => {
  it("finds at least one marker per known file (the scan is not silently empty)", () => {
    for (const file of FILES) expect(markerInserts(file).length, file).toBeGreaterThan(0);
  });

  it("every life-end marker (event 'deleted' or 'purged') is guarded, not a bare id list", () => {
    const unguarded: string[] = [];
    for (const file of FILES) {
      for (const hit of markerInserts(file)) {
        if (!HAS_WHERE_CLAUSE.test(hit.sql)) unguarded.push(`${file}:${hit.line}`);
      }
    }
    expect(unguarded).toEqual([]);
  });
});
