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
const REVIEWED_TABLE: { file: string; line: number; kind: string }[] = [
  { file: 'src/capture/classify.ts', line: 68, kind: 'exempt' },
  { file: 'src/capture/classify.ts', line: 78, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 244, kind: 'snapshot' },
  { file: 'src/capture/entry.ts', line: 283, kind: 'snapshot' },
  { file: 'src/capture/entry.ts', line: 369, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 406, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 413, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 415, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 453, kind: 'snapshot' },
  { file: 'src/capture/entry.ts', line: 497, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 506, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 508, kind: 'exempt' },
  { file: 'src/capture/lifecycle.ts', line: 127, kind: 'snapshot' },
  { file: 'src/capture/lifecycle.ts', line: 176, kind: 'snapshot' },
  { file: 'src/capture/share.ts', line: 75, kind: 'exempt' },
  { file: 'src/capture/store.ts', line: 53, kind: 'exempt' },
  { file: 'src/capture/store.ts', line: 205, kind: 'exempt' },
  { file: 'src/capture/store.ts', line: 220, kind: 'exempt' },
  { file: 'src/capture/store.ts', line: 417, kind: 'snapshot' },
  { file: 'src/capture/store.ts', line: 585, kind: 'snapshot' },
  { file: 'src/capture/store.ts', line: 671, kind: 'snapshot' },
  { file: 'src/compression/digest.ts', line: 102, kind: 'snapshot' },
  { file: 'src/entries/import.ts', line: 26, kind: 'exempt' },
  { file: 'src/integrations/mirror.ts', line: 96, kind: 'exempt' },
  { file: 'src/integrations/mirror.ts', line: 148, kind: 'snapshot' },
  { file: 'src/lib/team-admin.ts', line: 587, kind: 'hard-delete' },
  { file: 'src/lib/tenancy.ts', line: 128, kind: 'exempt' },
  { file: 'src/memory/actions.ts', line: 60, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 103, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 115, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 127, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 168, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 179, kind: 'snapshot' },
  { file: 'src/memory/trash.ts', line: 140, kind: 'trash' },
  { file: 'src/memory/trash.ts', line: 498, kind: 'exempt' },
  { file: 'src/memory/trash.ts', line: 613, kind: 'hard-delete' },
  { file: 'src/memory/undo.ts', line: 233, kind: 'snapshot' },
  { file: 'src/memory/undo.ts', line: 258, kind: 'exempt' },
  { file: 'src/recall/search.ts', line: 1115, kind: 'exempt' },
  { file: 'src/routes/admin.ts', line: 1538, kind: 'exempt' },
  { file: 'src/staleness/pass.ts', line: 86, kind: 'exempt' },
  { file: 'src/staleness/pass.ts', line: 96, kind: 'exempt' },
  { file: 'src/when/pass.ts', line: 367, kind: 'exempt' },
];

/**
 * Cron/hygiene sites that are REST- or MCP-reachable (an admin route, in classify's case) but not
 * a user- or agent-observable change to a memory's content, tags or due date — the design calls
 * these out by name as staying unversioned. Everything else that touches tags or when_* must be
 * snapshot, trash or hard-delete (the undo invariant).
 */
const HYGIENE_EXEMPT = new Set([
  "src/staleness/pass.ts:86", "src/staleness/pass.ts:96",
  "src/when/pass.ts:367",
  "src/capture/classify.ts:78", "src/routes/admin.ts:1538", // /classify-pending and applyClassification (hygiene)
  // captureEntry retags its OWN new row before returning, while it has no version chain yet
  // (design row 18): the caller sees the final tags in the same response, nothing to undo.
  "src/capture/entry.ts:406", "src/capture/entry.ts:497",
]);

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

  it("every REST- or MCP-reachable write of tags or when_* is marked snapshot, trash or hard-delete", () => {
    const setClause = (sql: string) => (/\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql)?.[1] ?? "");
    const tagsOrWhenWrites = sites.filter(s => /\btags\s*=/i.test(setClause(s.sql)) || /\bwhen_(at|kind|label|source)\s*=/i.test(setClause(s.sql)));
    const reachable = tagsOrWhenWrites.filter(s => !HYGIENE_EXEMPT.has(`${s.file}:${s.line}`));
    expect(reachable.length).toBeGreaterThan(0);
    for (const s of reachable) {
      expect(["snapshot", "trash", "hard-delete"], `${s.file}:${s.line}`).toContain(s.markerKind);
    }
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
