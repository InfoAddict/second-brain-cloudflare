/**
 * Write-path inventory guard (Task 6, T-0089.1.1).
 *
 * Every SQL statement that writes to `entries` must say, right above it, what it does to that
 * row's history: `// versioning: snapshot | trash | hard-delete: <why> | exempt: <why>`. This
 * scans src/ the way scripts/check-scope.mjs does — the same template-literal lexer, so a
 * statement neither script can read fails loudly rather than passing both silently.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { writerSpans } from "../../scripts/check-scope.mjs";
import { isEntriesWriteSql } from "../../src/db/fts-write-guard";

const ROOT = resolveRoot();
function resolveRoot(): string {
  return join(import.meta.dirname, "../..");
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

function lineOf(text: string, idx: number): number {
  return text.slice(0, idx).split("\n").length;
}

const MARKER = /\/\/\s*versioning:\s*(snapshot|trash|hard-delete:.*|exempt:.*)/;

interface Site { file: string; line: number; sql: string; markerKind: string | null; markerText: string | null }

/** Every entries-write statement under src/, with whatever marker sits within 3 lines above it. */
function scanInventory(): Site[] {
  const sites: Site[] = [];
  for (const path of walk(join(ROOT, "src"))) {
    const file = relative(ROOT, path);
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const spans = writerSpans(text) as { start: number; end: number }[];
    for (const span of spans) {
      const sql = text.slice(span.start + 1, span.end);
      if (!isEntriesWriteSql(sql)) continue;
      const line = lineOf(text, span.start);
      let markerKind: string | null = null;
      let markerText: string | null = null;
      for (let l = line; l >= Math.max(1, line - 3); l--) {
        const m = MARKER.exec(lines[l - 1] ?? "");
        if (m) {
          markerText = m[1];
          markerKind = m[1].startsWith("hard-delete") ? "hard-delete" : m[1].startsWith("exempt") ? "exempt" : m[1];
          break;
        }
      }
      sites.push({ file, line, sql, markerKind, markerText });
    }
  }
  return sites;
}

/**
 * The reviewed table, one entry per code site (writer table in the spec, plus the compare-and-set
 * forms Tasks 3a and 4a added and row 29's vector-bookkeeping exempt, L5). Frozen: a writer that
 * moves, is added, or is removed must update this list by hand, which is the point.
 */
// MOVED to real --inventory output (merge of release/v4 d3b5b25c into v4/t7-c, T-0089.7.1/.2/.3):
// Track 2's validity columns/supersede/retraction rework and Track 7's standing/decision/
// commitment/resolve work landed on src/capture/entry.ts, src/memory/actions.ts,
// src/routes/admin.ts and others independently. Recomputed against the real scanner output after
// combining rather than hand-reconciling two independently-tracked line sets, same reasoning as
// every prior cross-track merge this table records — see the history further below.
const REVIEWED_TABLE: { file: string; line: number; kind: string }[] = [
  // MOVED to real --inventory output (T-0089.4.2, Codex review classes A-D): the embed gate,
  // the pending-scan hold redesign and its chunked nightly rescan all shifted or added
  // entries-write sites. Recomputed against the real scanner output.
  { file: 'src/capture/classify.ts', line: 68, kind: 'exempt' },
  { file: 'src/capture/classify.ts', line: 78, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 358, kind: 'snapshot' },
  { file: 'src/capture/entry.ts', line: 402, kind: 'snapshot' },
  { file: 'src/capture/entry.ts', line: 522, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 588, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 595, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 597, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 632, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 649, kind: 'exempt' },
  { file: 'src/capture/lifecycle.ts', line: 158, kind: 'snapshot' },
  { file: 'src/capture/lifecycle.ts', line: 235, kind: 'snapshot' },
  { file: 'src/capture/share.ts', line: 78, kind: 'exempt' },
  { file: 'src/capture/store.ts', line: 74, kind: 'exempt' },
  { file: 'src/capture/store.ts', line: 445, kind: 'snapshot' },
  { file: 'src/capture/store.ts', line: 682, kind: 'snapshot' },
  { file: 'src/capture/store.ts', line: 790, kind: 'snapshot' },
  { file: 'src/compression/digest.ts', line: 102, kind: 'snapshot' },
  { file: 'src/entries/import.ts', line: 34, kind: 'exempt' },
  { file: 'src/integrations/mirror.ts', line: 111, kind: 'exempt' },
  { file: 'src/integrations/mirror.ts', line: 193, kind: 'snapshot' },
  { file: 'src/lib/team-admin.ts', line: 592, kind: 'hard-delete' },
  { file: 'src/lib/tenancy.ts', line: 128, kind: 'exempt' },
  { file: 'src/memory/actions.ts', line: 73, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 131, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 145, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 157, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 169, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 250, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 291, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 303, kind: 'snapshot' },
  { file: 'src/memory/trash.ts', line: 230, kind: 'trash' },
  { file: 'src/memory/trash.ts', line: 621, kind: 'exempt' },
  { file: 'src/memory/undo.ts', line: 174, kind: 'snapshot' },
  { file: 'src/memory/undo.ts', line: 469, kind: 'snapshot' },
  { file: 'src/memory/undo.ts', line: 505, kind: 'exempt' },
  { file: 'src/memory/validity.ts', line: 161, kind: 'snapshot' },
  { file: 'src/memory/validity.ts', line: 301, kind: 'snapshot' },
  { file: 'src/memory/validity.ts', line: 370, kind: 'snapshot' },
  { file: 'src/memory/validity.ts', line: 413, kind: 'snapshot' },
  { file: 'src/memory/validity.ts', line: 457, kind: 'snapshot' },
  { file: 'src/memory/validity.ts', line: 616, kind: 'snapshot' },
  { file: 'src/memory/validity.ts', line: 634, kind: 'snapshot' },
  { file: 'src/quarantine/hold.ts', line: 113, kind: 'snapshot' },
  { file: 'src/quarantine/rescan.ts', line: 135, kind: 'snapshot' },
  { file: 'src/quarantine/rescan.ts', line: 154, kind: 'exempt' },
  { file: 'src/quarantine/rescan.ts', line: 209, kind: 'snapshot' },
  { file: 'src/recall/search.ts', line: 1287, kind: 'exempt' },
  { file: 'src/routes/admin.ts', line: 1563, kind: 'exempt' },
  { file: 'src/staleness/pass.ts', line: 87, kind: 'exempt' },
  { file: 'src/staleness/pass.ts', line: 97, kind: 'exempt' },
  { file: 'src/vectorize/pending.ts', line: 165, kind: 'exempt' },
  { file: 'src/when/pass.ts', line: 368, kind: 'exempt' },
];

/**
 * Cron/hygiene sites that are REST- or MCP-reachable (an admin route, in classify's case) but not
 * a user- or agent-observable change to a memory's content, tags or due date — the design calls
 * these out by name as staying unversioned. Everything else that touches tags or when_* must be
 * snapshot, trash or hard-delete (the undo invariant).
 */
const HYGIENE_EXEMPT = new Set([
  "src/staleness/pass.ts:87", "src/staleness/pass.ts:97",
  "src/when/pass.ts:368",
  "src/capture/classify.ts:78", "src/routes/admin.ts:1563", // /classify-pending and applyClassification (hygiene)
  // captureEntry retags its OWN new row before returning, while it has no version chain yet
  // (design row 18): the caller sees the final tags in the same response, nothing to undo.
  // MOVED 540/601 -> 589/650 (T-0089.4.2, Lane W): W1's scoring code shifted these down; same two sites.
  "src/capture/entry.ts:588", "src/capture/entry.ts:649",
  // The nightly quarantine-rescan pass (5.1 point 2 follow-up) clears its own NEEDS_RESCAN_TAG
  // pipeline marker once a row's unscanned middle has been checked: bookkeeping, not a
  // user-visible change, and the row's hold path (a real tags edit) is its own snapshot site above.
  "src/quarantine/rescan.ts:154",
]);

const setClause = (sql: string) => (/\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql)?.[1] ?? "");
/** A SET of tags, a when_* column, or a validity column (T-0089.2.1): state undo must be able to restore. */
const undoableStateWrite = (sql: string) =>
  /\btags\s*=/i.test(setClause(sql)) || /\bwhen_(at|kind|label|source)\s*=/i.test(setClause(sql)) || /\bvalid_(from|until)\s*=/i.test(setClause(sql));

describe("write-path inventory guard", () => {
  const sites = scanInventory();


  it("every write to entries carries a versioning marker", () => {
    const unmarked = sites.filter(s => s.markerKind === null).map(s => `${s.file}:${s.line}`);
    expect(unmarked).toEqual([]);
  });

  it("the inventory matches the reviewed table", () => {
    const actual = sites.map(s => ({ file: s.file, line: s.line, kind: s.markerKind })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const expected = [...REVIEWED_TABLE].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    expect(actual).toEqual(expected);
  });

  it("every content-changing write is marked snapshot", () => {
    // Only the SET clause counts: a CAS guard's WHERE ... AND content = ? is a read, not a write.
    const setClause = (sql: string) => (/\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql)?.[1] ?? "");
    const contentWrites = sites.filter(s => /\bcontent\s*=/i.test(setClause(s.sql)) || /\bcontent\s*\|\|/i.test(setClause(s.sql)));
    expect(contentWrites.length).toBeGreaterThan(0);
    for (const s of contentWrites) {
      expect(s.markerKind, `${s.file}:${s.line}`).toBe("snapshot");
    }
  });

  it("every REST- or MCP-reachable write of tags, when_* or valid_* is marked snapshot, trash or hard-delete", () => {
    const tagsOrWhenWrites = sites.filter(s => undoableStateWrite(s.sql));
    const reachable = tagsOrWhenWrites.filter(s => !HYGIENE_EXEMPT.has(`${s.file}:${s.line}`));
    expect(reachable.length).toBeGreaterThan(0);
    for (const s of reachable) {
      expect(["snapshot", "trash", "hard-delete"], `${s.file}:${s.line}`).toContain(s.markerKind);
    }
  });
});

describe("undoable state writes", () => {
  it("the inventory rule requires a snapshot marker on any SET of valid_from or valid_until", () => {
    expect(undoableStateWrite(`UPDATE entries AS e SET valid_until = ?1 WHERE e.id = ?2`)).toBe(true);
    expect(undoableStateWrite(`UPDATE entries SET valid_from = ?, valid_until = ? WHERE id = ?`)).toBe(true);
    expect(undoableStateWrite(`UPDATE entries SET recall_count = 1 WHERE valid_until IS NULL`)).toBe(false);
  });
});

describe("isEntriesWriteSql", () => {
  it("still matches WITH-prefixed, REPLACE INTO and quoted-name writes", () => {
    expect(isEntriesWriteSql(`WITH x AS (SELECT 1) UPDATE entries SET tags = ? WHERE id = ?`)).toBe(true);
    expect(isEntriesWriteSql(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 5) UPDATE entries SET tags = ?`)).toBe(true);
    expect(isEntriesWriteSql(`REPLACE INTO entries (id, content) VALUES (?, ?)`)).toBe(true);
    expect(isEntriesWriteSql(`UPDATE "entries" SET tags = ? WHERE id = ?`)).toBe(true);
    expect(isEntriesWriteSql("UPDATE `entries` SET tags = ? WHERE id = ?")).toBe(true);
    expect(isEntriesWriteSql(`UPDATE [entries] SET tags = ? WHERE id = ?`)).toBe(true);
    expect(isEntriesWriteSql(`UPDATE entries_fts SET rank = ?`)).toBe(false);
    expect(isEntriesWriteSql(`SELECT * FROM entries`)).toBe(false);
  });
});
