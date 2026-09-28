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
/**
 * `standing` (Track 7 lane D Tasks 11-12, spec 15 2.6): `touch` when a written row's prior or
 * next tags can contain standing:active and the writer calls standingTouched somewhere in its
 * own file (checked per-file, not per-statement: several touch sites share one orchestrator
 * elsewhere in the same file that already makes the call). Every other site is `exempt: <why>`.
 */
const REVIEWED_TABLE: { file: string; line: number; kind: string; standing: string }[] = [
  // MOVED (merge of release/v4 5a98da4a into v4/t7-d, lane W merged, T-0089.4.2/T-0089.7.1): lane
  // W's own class E/A/R20 deltas and lane D's Task 12 deferred call sites (captureEntry's merge
  // gate fix, the supersede-close touch, updateEntryContent and appendToEntry) are independently-
  // tracked from the same base c870e5ac — recomputed against the real scanner output on the
  // merged tree, not hand-combined.
  { file: 'src/capture/classify.ts', line: 68, kind: 'exempt', standing: 'exempt: importance_score only, no tags column' },
  { file: 'src/capture/classify.ts', line: 78, kind: 'exempt', standing: 'exempt: withKind/withStatus only add or replace the kind/canonical marker; standing:active (if present) survives unchanged either way' },
  { file: 'src/capture/entry.ts', line: 370, kind: 'snapshot', standing: 'exempt: a system job merges only into what a system job wrote (isSystemRow), which a person\'s standing capture never is' },
  { file: 'src/capture/entry.ts', line: 414, kind: 'snapshot', standing: 'touch' },
  { file: 'src/capture/entry.ts', line: 538, kind: 'exempt', standing: 'touch' },
  { file: 'src/capture/entry.ts', line: 604, kind: 'exempt', standing: 'exempt: keepAsDraft\'s protective self-tag; scheduleIndex(protectedTags) right below it is this same new row\'s own standingKnownVector touch' },
  { file: 'src/capture/entry.ts', line: 611, kind: 'exempt', standing: 'exempt: contradiction_wins counter only, no tags column' },
  { file: 'src/capture/entry.ts', line: 613, kind: 'exempt', standing: 'exempt: contradiction_losses counter only, no tags column' },
  { file: 'src/capture/entry.ts', line: 648, kind: 'exempt', standing: 'exempt: a window-closed bump counter, no tags column' },
  { file: 'src/capture/entry.ts', line: 665, kind: 'exempt', standing: 'exempt: the lost-race retry\'s own protective retag; scheduleIndex(keptTags) right below it is this same row\'s own standingKnownVector touch' },
  { file: 'src/capture/lifecycle.ts', line: 178, kind: 'snapshot', standing: 'touch' },
  { file: 'src/capture/lifecycle.ts', line: 256, kind: 'snapshot', standing: 'touch' },
  { file: 'src/capture/share.ts', line: 82, kind: 'exempt', standing: 'exempt: workspace_id only, no tags column; moveEntry\'s own touch call (both workspaces) reads tags separately after this statement' },
  { file: 'src/capture/store.ts', line: 97, kind: 'exempt', standing: 'exempt: vector_ids only, no tags column' },
  { file: 'src/capture/store.ts', line: 476, kind: 'snapshot', standing: 'touch' },
  { file: 'src/capture/store.ts', line: 728, kind: 'snapshot', standing: 'touch' },
  { file: 'src/capture/store.ts', line: 838, kind: 'snapshot', standing: 'touch' },
  { file: 'src/compression/digest.ts', line: 103, kind: 'snapshot', standing: 'exempt: rollup marker on the source row, unaffected by compressionEligibilitySql\'s own standing:active exclusion' },
  { file: 'src/entries/import.ts', line: 36, kind: 'exempt', standing: 'touch' },
  { file: 'src/integrations/mirror.ts', line: 111, kind: 'exempt', standing: 'exempt: mirrors cannot carry standing:active — 1.3 strips it via stripT7CallerTags before mirror tags are built' },
  { file: 'src/integrations/mirror.ts', line: 193, kind: 'snapshot', standing: 'exempt: mirrors cannot carry standing:active — 1.3 strips it via stripT7CallerTags before mirror tags are built' },
  { file: 'src/lib/team-admin.ts', line: 594, kind: 'hard-delete', standing: 'touch' },
  { file: 'src/lib/tenancy.ts', line: 128, kind: 'exempt', standing: 'exempt: one-time pre-v3 tenancy bootstrap moving every legacy "" row to the new owner workspace; a legacy standing row would need a cache rebuild after migration, which the 24h revalidation (P7.4) supplies on its own' },
  { file: 'src/memory/actions.ts', line: 73, kind: 'snapshot', standing: 'exempt: withoutStaleAsOf/RETRACTED_SOURCE_TAG only, never touches standing:active' },
  { file: 'src/memory/actions.ts', line: 131, kind: 'snapshot', standing: 'exempt: withTaskDone/withoutTask only, never touches standing:active' },
  { file: 'src/memory/actions.ts', line: 145, kind: 'snapshot', standing: 'touch' },
  { file: 'src/memory/actions.ts', line: 157, kind: 'snapshot', standing: 'exempt: when_at only, no tags column' },
  { file: 'src/memory/actions.ts', line: 169, kind: 'snapshot', standing: 'exempt: when_* only, no tags column' },
  { file: 'src/memory/actions.ts', line: 250, kind: 'snapshot', standing: 'exempt: a decision outcome; decision and standing are mutually exclusive at capture (2.1/4.1)' },
  { file: 'src/memory/actions.ts', line: 291, kind: 'snapshot', standing: 'exempt: auto-insight rows are system-generated candidates, never standing:active' },
  { file: 'src/memory/actions.ts', line: 303, kind: 'snapshot', standing: 'exempt: auto-insight rows are system-generated candidates, never standing:active' },
  { file: 'src/memory/trash.ts', line: 233, kind: 'trash', standing: 'touch' },
  { file: 'src/memory/trash.ts', line: 637, kind: 'exempt', standing: 'touch' },
  { file: 'src/memory/undo.ts', line: 186, kind: 'snapshot', standing: 'exempt: KNOWN GAP, not fixed here — releaseHeldAfterEdit releases a Track 4 hold via a tags-only change (5.6, the row was edited after the hold), which can restore standing:active without going through revertEntry\'s own touch. Not in the director\'s named list for this pass; self-heals within 24h (P7.4), flagged for the director rather than fixed in scope here' },
  { file: 'src/memory/undo.ts', line: 482, kind: 'snapshot', standing: 'touch' },
  { file: 'src/memory/undo.ts', line: 518, kind: 'exempt', standing: 'exempt: KNOWN GAP, not fixed here — a merge-undo re-creates the incoming row a merge had absorbed; if that absorbed content was itself standing:active this would need a touch too. Rare (a merge target and its incoming are topically close, not a disjoint standing instruction) and self-heals within 24h (P7.4), flagged for the director, not implemented in this pass' },
  { file: 'src/memory/validity.ts', line: 166, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  { file: 'src/memory/validity.ts', line: 306, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  { file: 'src/memory/validity.ts', line: 375, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  { file: 'src/memory/validity.ts', line: 418, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  { file: 'src/memory/validity.ts', line: 462, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  { file: 'src/memory/validity.ts', line: 622, kind: 'snapshot', standing: 'touch' },
  { file: 'src/memory/validity.ts', line: 640, kind: 'snapshot', standing: 'exempt: the propagate UPDATE moves a REPLACED row\'s own valid_until; a standing row is never itself in a supersede chain, and if it were, the primary row\'s own touch above plus the 24h revalidation (2.4) covers it' },
  { file: 'src/quarantine/hold.ts', line: 113, kind: 'snapshot', standing: 'exempt: Track 4\'s own quarantine hold/release wiring (spec 15 2.13, Task 16), not lane D' },
  { file: 'src/recall/search.ts', line: 1423, kind: 'exempt', standing: 'exempt: recall_count bookkeeping only, no tags column' },
  { file: 'src/routes/admin.ts', line: 1569, kind: 'exempt', standing: 'exempt: same hygiene classify write as capture/classify.ts:78 (withKind/withStatus only), never touches standing:active' },
  { file: 'src/staleness/pass.ts', line: 91, kind: 'exempt', standing: 'exempt: a staleness marker addition, never removes standing:active, and hydration re-checks validity independently (2.4/2.6) regardless' },
  { file: 'src/staleness/pass.ts', line: 101, kind: 'exempt', standing: 'exempt: staleness_checked_at only, no tags column' },
  { file: 'src/vectorize/pending.ts', line: 165, kind: 'exempt', standing: 'exempt: vector_ids only, no tags column' },
  { file: 'src/when/pass.ts', line: 373, kind: 'exempt', standing: 'exempt: when_* only, no tags column' },
];

/**
 * Cron/hygiene sites that are REST- or MCP-reachable (an admin route, in classify's case) but not
 * a user- or agent-observable change to a memory's content, tags or due date — the design calls
 * these out by name as staying unversioned. Everything else that touches tags or when_* must be
 * snapshot, trash or hard-delete (the undo invariant).
 */
const HYGIENE_EXEMPT = new Set([
  "src/staleness/pass.ts:91", "src/staleness/pass.ts:101",
  // MOVED (merge of release/v4 c870e5ac into v4/t34-w, T-0089.4.2): recomputed against the real
  // scanner output on the merged tree.
  "src/when/pass.ts:373",
  "src/capture/classify.ts:78", "src/routes/admin.ts:1569", // /classify-pending and applyClassification (hygiene)
  // captureEntry retags its OWN new row before returning, while it has no version chain yet
  // (design row 18): the caller sees the final tags in the same response, nothing to undo.
  // MOVED 540/601 -> 589/650 -> 591/652 -> 598/659 -> 600/661 -> 604/665 (T-0089.4.2 Lane W, then
  // Task 12's merge-gate fix and supersede-close touch above them): same two sites throughout.
  "src/capture/entry.ts:604", "src/capture/entry.ts:665",
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
    const expected = REVIEWED_TABLE.map(({ file, line, kind }) => ({ file, line, kind })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    expect(actual).toEqual(expected);
  });

  it("every entries writer is classified for standing invalidation", () => {
    const bad = REVIEWED_TABLE.filter(s => s.standing !== "touch" && !s.standing.startsWith("exempt:")).map(s => `${s.file}:${s.line}`);
    expect(bad).toEqual([]);
  });

  it("every touch-classified writer calls standingTouched somewhere in its own file", () => {
    // Per file, not per statement (the docblock above REVIEWED_TABLE explains why): several touch
    // sites share one orchestrator elsewhere in the same file that already makes the call.
    const touchFiles = [...new Set(REVIEWED_TABLE.filter(s => s.standing === "touch").map(s => s.file))];
    expect(touchFiles.length).toBeGreaterThan(0);
    const missing = touchFiles.filter(file => !/\bstandingTouched\(/.test(readFileSync(join(ROOT, file), "utf8")));
    expect(missing).toEqual([]);
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
