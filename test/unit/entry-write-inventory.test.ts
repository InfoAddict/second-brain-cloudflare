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
// MOVED to real --inventory output (merge of bd04512a, release/v4 into v4/t1-foundations,
// T-0089.1.1): several other tracks' work (explain, quarantine, reserved tags, t7) landed on
// src/capture/entry.ts and src/recall/search.ts between this table's last update and this merge,
// shifting lines this branch's own commits never touched. Recomputed against the real scanner
// output after combining rather than hand-reconciling two independently-tracked line sets, same
// reasoning as every prior cross-track merge this table records — see the history further below.
// MOVED (T-0089.1.1 final round): shared delete helper and the id bound shifted these lines; same sites.
const REVIEWED_TABLE: { file: string; line: number; kind: string }[] = [
  { file: 'src/capture/classify.ts', line: 68, kind: 'exempt' },
  { file: 'src/capture/classify.ts', line: 78, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 250, kind: 'snapshot' },
  { file: 'src/capture/entry.ts', line: 289, kind: 'snapshot' },
  { file: 'src/capture/entry.ts', line: 376, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 413, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 420, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 422, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 460, kind: 'snapshot' },
  { file: 'src/capture/entry.ts', line: 504, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 513, kind: 'exempt' },
  { file: 'src/capture/entry.ts', line: 515, kind: 'exempt' },
  { file: 'src/capture/lifecycle.ts', line: 128, kind: 'snapshot' },
  { file: 'src/capture/lifecycle.ts', line: 196, kind: 'snapshot' },
  { file: 'src/capture/share.ts', line: 78, kind: 'exempt' },
  // MOVED 56 -> 60 and every later store.ts site (T-0089.1.1 round 5): storeEntry's CAS pins the
  // workspace, StoredEntry gains `committed`, and settleLostVectorCommit is new; same sites.
  // REMOVED store.ts 243/274/295 and MOVED the rest (T-0089.1.1 round 6): restoreRowVectors and its
  // three vector_ids writes are gone (per-upload vector ids); a losing writer deletes only its own upload.
  { file: 'src/capture/store.ts', line: 62, kind: 'exempt' },
  // MOVED +3 below line 56 (T-0089.1.1 round 3): upsertEntryVectors takes an opt-in batchEmbeds option.
  { file: 'src/capture/store.ts', line: 383, kind: 'snapshot' },
  { file: 'src/capture/store.ts', line: 547, kind: 'snapshot' },
  { file: 'src/capture/store.ts', line: 632, kind: 'snapshot' },
  { file: 'src/compression/digest.ts', line: 102, kind: 'snapshot' },
  // MOVED 26 -> 30 (T-0089.1.1 round 2): the id-uniqueness comment above import's insert, which now mints a fresh id in-statement.
  { file: 'src/entries/import.ts', line: 33, kind: 'exempt' },
  { file: 'src/integrations/mirror.ts', line: 96, kind: 'exempt' },
  { file: 'src/integrations/mirror.ts', line: 148, kind: 'snapshot' },
  // MOVED 591 -> 592 (T-0089.2.1): the retraction-exempt marker above it.
  { file: 'src/lib/team-admin.ts', line: 592, kind: 'hard-delete' },
  { file: 'src/lib/tenancy.ts', line: 128, kind: 'exempt' },
  { file: 'src/memory/actions.ts', line: 64, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 107, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 119, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 131, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 173, kind: 'snapshot' },
  { file: 'src/memory/actions.ts', line: 184, kind: 'snapshot' },
  // MOVED 218 -> 220, 605 -> 607 (T-0089.1.1 round 2): the trash insert is a plain INSERT, with a comment saying why.
  // MOVED 220 -> 221, 607 -> 608 (T-0089.1.1 round 3): trash.ts imports the shared edge readability guard.
  { file: 'src/memory/trash.ts', line: 221, kind: 'trash' },
  { file: 'src/memory/trash.ts', line: 588, kind: 'exempt' },
  // REMOVED trash.ts:760 (T-0089.1.1 close-out): deleteForever no longer deletes a live entry at all;
  // it acts only on a trash row pinned by nonce.
  // MOVED 312 -> 316, 348 -> 352 (T-0089.1.1 round 2): revertEntry takes an optional trash nonce; same sites.
  // MOVED 320 -> 336, 356 -> 372 (T-0089.2.1): revertEntry restores the validity window too.
  { file: 'src/memory/undo.ts', line: 336, kind: 'snapshot' },
  { file: 'src/memory/undo.ts', line: 372, kind: 'exempt' },
  // NEW (T-0089.2.1): the supersede UPDATE (validity window closed; its validity snapshot rides in the same batch).
  { file: 'src/memory/validity.ts', line: 90, kind: 'snapshot' },
  // NEW (merge of release/v4 ebc8010d, lane Q): holdStatements' guarded tags UPDATE, whose snapshot rides
  // in the same batch. Not wired into a writer yet; a caller deletes the cleared vectors after commit.
  { file: 'src/quarantine/hold.ts', line: 94, kind: 'snapshot' },
  // MOVED 1235 -> 1257 (T-0089.2.1): the validity predicate and superseded_by
  // subquery added lines to the hydration block above this site; same site, shifted only.
  { file: 'src/recall/search.ts', line: 1257, kind: 'exempt' },
  // MOVED 1538 -> 1544 (T-0089.1.1, adv-final MAJOR 2): /vectorize-pending's remaining/
  // retryAfterMs rework added lines above this site; same site, shifted only.
  // MOVED 1544 -> 1531 (T-0089.1.1 close-out): /vectorize-pending's loop moved into vectorize/pending.ts.
  { file: 'src/routes/admin.ts', line: 1531, kind: 'exempt' },
  { file: 'src/staleness/pass.ts', line: 86, kind: 'exempt' },
  { file: 'src/staleness/pass.ts', line: 96, kind: 'exempt' },
  // NEW (T-0089.1.1 close-out): the nightly vectorize-pending pass's batched vector_ids CAS, as storeEntry's.
  // MOVED 78 -> 89 (T-0089.1.1 round 3): the pass plans from lengths, then reads the chosen rows.
  // MOVED 89 -> 93 (T-0089.1.1 round 5): indexPendingRow reports whether its commit landed.
  // MOVED 93 -> 131 (T-0089.1.1 round 5): failure counting and demotion above the batch; same site.
  // MOVED 131 -> 151 (T-0089.1.1, budget auditor R11): the 128 KB nightly cap and its skip count.
  { file: 'src/vectorize/pending.ts', line: 165, kind: 'exempt' },
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
  "src/capture/classify.ts:78", "src/routes/admin.ts:1531", // /classify-pending and applyClassification (hygiene)
  // captureEntry retags its OWN new row before returning, while it has no version chain yet
  // (design row 18): the caller sees the final tags in the same response, nothing to undo.
  "src/capture/entry.ts:413", "src/capture/entry.ts:504",
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
