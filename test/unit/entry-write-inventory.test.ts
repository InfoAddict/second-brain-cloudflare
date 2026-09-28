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
 * `standing` (Track 7 lane D Task 12, spec 15 2.6): `touch` when a written row's prior or next
 * tags can contain standing:active and the writer calls standingTouched somewhere in its own
 * file (the guard below checks per-file, not per-statement: several of these sites share one
 * orchestrator elsewhere in the same file that already does the check and the call). Every other
 * site is `exempt: <why>` — most because the statement cannot write the tags column at all, the
 * rest because the row class it writes structurally cannot carry standing:active, or because the
 * cache's own hydration re-checks validity independently (2.4/2.6), so a missed touch there only
 * delays pruning, never a false fire.
 */
const REVIEWED_TABLE: { file: string; line: number; kind: string; standing: string }[] = [
  { file: 'src/capture/classify.ts', line: 68, kind: 'exempt', standing: 'exempt: importance_score only, no tags column' },
  { file: 'src/capture/classify.ts', line: 78, kind: 'exempt', standing: 'exempt: withKind/withStatus only add or replace the kind/canonical marker; standing:active (if present) survives unchanged either way' },
  { file: 'src/capture/entry.ts', line: 333, kind: 'snapshot', standing: 'exempt: lane W (T7-capture) in progress; deferred until lane W merges, per director' },
  { file: 'src/capture/entry.ts', line: 377, kind: 'snapshot', standing: 'exempt: lane W (T7-capture) in progress; deferred until lane W merges, per director' },
  { file: 'src/capture/entry.ts', line: 497, kind: 'exempt', standing: 'exempt: lane W (T7-capture) in progress; deferred until lane W merges, per director' },
  { file: 'src/capture/entry.ts', line: 540, kind: 'exempt', standing: 'exempt: lane W (T7-capture) in progress; deferred until lane W merges, per director' },
  { file: 'src/capture/entry.ts', line: 547, kind: 'exempt', standing: 'exempt: contradiction_wins counter only, no tags column' },
  { file: 'src/capture/entry.ts', line: 549, kind: 'exempt', standing: 'exempt: contradiction_losses counter only, no tags column' },
  { file: 'src/capture/entry.ts', line: 584, kind: 'exempt', standing: 'exempt: a window-closed bump counter, no tags column' },
  { file: 'src/capture/entry.ts', line: 601, kind: 'exempt', standing: 'exempt: lane W (T7-capture) in progress; deferred until lane W merges, per director' },
  // MOVED 152 -> 166 -> 172, 229 -> 244 -> 250 (Track 7 lane D Task 12): standingTouched wiring in
  // deprecateWithValidity and applyStatus (touchesStanding gate, and forgetEntry's own touch
  // below) added lines above both sites; same sites, shifted only.
  { file: 'src/capture/lifecycle.ts', line: 172, kind: 'snapshot', standing: 'touch' },
  { file: 'src/capture/lifecycle.ts', line: 250, kind: 'snapshot', standing: 'touch' },
  // MOVED 78 -> 81 (Task 12): the SELECT above it now also reads tags, for the touch check below.
  { file: 'src/capture/share.ts', line: 81, kind: 'exempt', standing: 'exempt: workspace_id only, no tags column; moveEntry\'s own touch call (both workspaces) reads tags separately after this statement' },
  // MOVED 56 -> 60 and every later store.ts site (T-0089.1.1 round 5): storeEntry's CAS pins the
  // workspace, StoredEntry gains `committed`, and settleLostVectorCommit is new; same sites.
  // REMOVED store.ts 243/274/295 and MOVED the rest (T-0089.1.1 round 6): restoreRowVectors and its
  // three vector_ids writes are gone (per-upload vector ids); a losing writer deletes only its own upload.
  { file: 'src/capture/store.ts', line: 62, kind: 'exempt', standing: 'exempt: vector_ids only, no tags column' },
  // MOVED +3 below line 56 (T-0089.1.1 round 3): upsertEntryVectors takes an opt-in batchEmbeds option.
  { file: 'src/capture/store.ts', line: 383, kind: 'snapshot', standing: 'exempt: lane W (T7-capture) in progress; deferred until lane W merges, per director' },
  { file: 'src/capture/store.ts', line: 547, kind: 'snapshot', standing: 'exempt: lane W (T7-capture) in progress; deferred until lane W merges, per director' },
  { file: 'src/capture/store.ts', line: 632, kind: 'snapshot', standing: 'exempt: lane W (T7-capture) in progress; deferred until lane W merges, per director' },
  // KNOWN GAP (Task 12, not fixed here — out of the touch-writer table's spec, not silently
  // ignored): compressionEligibilitySql (src/compression/eligibility.ts) checks importance_score,
  // recall_count and contradiction_wins only, never the row's own tags, so a low-importance,
  // never-recalled standing:active row is not structurally excluded from being rolled into a
  // digest under some OTHER tag it also carries. Design 2.6's table does not name digest.ts, and
  // fixing it is a compression-eligibility question, not a standing-invalidation one; flagged for
  // the director rather than fixed in scope here.
  { file: 'src/compression/digest.ts', line: 102, kind: 'snapshot', standing: 'exempt: see KNOWN GAP above' },
  // MOVED 26 -> 30 -> 35 (T-0089.1.1 round 2, then Task 12's ctx/resolveConfig imports above it).
  { file: 'src/entries/import.ts', line: 35, kind: 'exempt', standing: 'touch' },
  { file: 'src/integrations/mirror.ts', line: 96, kind: 'exempt', standing: 'exempt: mirrors cannot carry standing:active — 1.3 strips it via stripT7CallerTags before mirror tags are built' },
  { file: 'src/integrations/mirror.ts', line: 148, kind: 'snapshot', standing: 'exempt: mirrors cannot carry standing:active — 1.3 strips it via stripT7CallerTags before mirror tags are built' },
  // MOVED 591 -> 592 -> 594 (T-0089.2.1, then Task 12's standing-count column on the count read above it).
  { file: 'src/lib/team-admin.ts', line: 594, kind: 'hard-delete', standing: 'touch' },
  { file: 'src/lib/tenancy.ts', line: 128, kind: 'exempt', standing: 'exempt: one-time pre-v3 tenancy bootstrap moving every legacy "" row to the new owner workspace; a legacy standing row would need a cache rebuild after migration, which the 24h revalidation (P7.4) supplies on its own' },
  // MOVED +2 (review_at/reviewsDone, 18-copy-deck.md 8.4): OutcomeActionResult grew two fields.
  { file: 'src/memory/actions.ts', line: 73, kind: 'snapshot', standing: 'exempt: withoutStaleAsOf/RETRACTED_SOURCE_TAG only, never touches standing:active' },
  { file: 'src/memory/actions.ts', line: 131, kind: 'snapshot', standing: 'exempt: withTaskDone/withoutTask only, never touches standing:active' },
  { file: 'src/memory/actions.ts', line: 145, kind: 'snapshot', standing: 'touch' },
  { file: 'src/memory/actions.ts', line: 157, kind: 'snapshot', standing: 'exempt: when_at only, no tags column' },
  { file: 'src/memory/actions.ts', line: 169, kind: 'snapshot', standing: 'exempt: when_* only, no tags column' },
  { file: 'src/memory/actions.ts', line: 250, kind: 'snapshot', standing: 'exempt: a decision outcome; decision and standing are mutually exclusive at capture (2.1/4.1)' },
  { file: 'src/memory/actions.ts', line: 291, kind: 'snapshot', standing: 'exempt: auto-insight rows are system-generated candidates, never standing:active' },
  { file: 'src/memory/actions.ts', line: 303, kind: 'snapshot', standing: 'exempt: auto-insight rows are system-generated candidates, never standing:active' },
  // MOVED 218 -> 220 -> 228 -> 231 (T-0089.1.1 rounds 2/3, Task 12's tags column on trashSizeSelect).
  { file: 'src/memory/trash.ts', line: 231, kind: 'trash', standing: 'touch' },
  // MOVED 611 -> 625 (Task 12's tags column on trashSizeSelect, and the ctx params/touch calls above it).
  { file: 'src/memory/trash.ts', line: 625, kind: 'exempt', standing: 'touch' },
  // REMOVED trash.ts:760 (T-0089.1.1 close-out): deleteForever no longer deletes a live entry at all;
  // it acts only on a trash row pinned by nonce.
  // MOVED 312 -> 316, 348 -> 352 (T-0089.1.1 round 2): revertEntry takes an optional trash nonce; same sites.
  // MOVED 320 -> 336, 356 -> 372 -> 346 -> 382 (T-0089.2.1, then Task 12's ctx param): revertEntry
  // restores the validity window too, then threads ctx for its own standing touch.
  { file: 'src/memory/undo.ts', line: 346, kind: 'snapshot', standing: 'touch' },
  { file: 'src/memory/undo.ts', line: 382, kind: 'exempt', standing: 'exempt: KNOWN GAP, not fixed here — a merge-undo re-creates the incoming row a merge had absorbed; if that absorbed content was itself standing:active this would need a touch too. Rare (a merge target and its incoming are topically close, not a disjoint standing instruction) and self-heals within 24h (P7.4); flagged for the director, not implemented in this pass' },
  // NEW (T-0089.2.1): the supersede UPDATE (validity window closed; its validity snapshot rides in the same batch).
  { file: 'src/memory/validity.ts', line: 165, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  // NEW (T-0089.2.4): the retraction restore and un-retraction re-close UPDATEs (D-RET), and the
  // cascade's flag and unflag UPDATEs; each rides after its own derived snapshot in the same batch,
  // and lands only on the rows that snapshot versioned (nonce).
  { file: 'src/memory/validity.ts', line: 305, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  { file: 'src/memory/validity.ts', line: 374, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  { file: 'src/memory/validity.ts', line: 417, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  { file: 'src/memory/validity.ts', line: 461, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  // NEW (T-0089.2.1, Task A4): update(valid_from / valid_until) and its propagate UPDATE, each with its validity snapshot.
  // MOVED +4 (lane A follow-up): the digest guard's comment shifted earlier lines in this file; same sites.
  { file: 'src/memory/validity.ts', line: 620, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  { file: 'src/memory/validity.ts', line: 638, kind: 'snapshot', standing: 'exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire' },
  // NEW (merge of release/v4 ebc8010d, lane Q): holdStatements' guarded tags UPDATE, whose snapshot rides
  // in the same batch. Not wired into a writer yet; a caller deletes the cleared vectors after commit.
  { file: 'src/quarantine/hold.ts', line: 94, kind: 'snapshot', standing: 'exempt: Track 4\'s own quarantine hold/release wiring (spec 15 2.13, Task 16), not lane D' },
  // MOVED (merge of release/v4 d3b5b25c into v4/t2-b): recomputed from the real scanner output on
  // the merged tree rather than hand-reconciling this branch's own line-history comments against
  // T-0089.5.2's recall log hook and lane A's supersededBySql fix.
  // MOVED -2 (director's R16 request): asOfPredicateSql inlined into its two keyword-search
  // template literals instead of a precomputed variable, so the R16 class guard can see it.
  // MOVED +2 (Task B6, T-0089.2.3): intent threaded into directOptions/rootOptions above; same site.
  // MOVED 1306 -> 1407 -> 1418 (Track 7 lane D Task 11): standing-fires-in-recall wiring, then the
  // hydration statement's own-branch scope markers; same site, shifted only.
  { file: 'src/recall/search.ts', line: 1418, kind: 'exempt', standing: 'exempt: recall_count bookkeeping only, no tags column' },
  // MOVED 1538 -> 1544 (T-0089.1.1, adv-final MAJOR 2): /vectorize-pending's remaining/
  // retryAfterMs rework added lines above this site; same site, shifted only.
  // MOVED 1544 -> 1531 (T-0089.1.1 close-out): /vectorize-pending's loop moved into vectorize/pending.ts.
  // MOVED 1531 -> 1534 -> 1540 (T-0089.2.1): the insights dry-run pair query's validity predicate,
  // then B2's due/loops/vectorize-pending validity-reader-inventory markers, added lines above this
  // site. MOVED 1540 -> 1544 (merge of release/v4 57583d10, T-0101.8.5 BE-10): history_since on
  // GET /health added lines above this site too. MOVED 1545 -> 1563 (merge of release/v4 c0eed34b,
  // Track 7-C decisions/commitments wiring): recomputed against the real scanner output; same site.
  { file: 'src/routes/admin.ts', line: 1564, kind: 'exempt', standing: 'exempt: same hygiene classify write as capture/classify.ts:78 (withKind/withStatus only), never touches standing:active' },
  { file: 'src/staleness/pass.ts', line: 87, kind: 'exempt', standing: 'exempt: a staleness marker addition, never removes standing:active, and hydration re-checks validity independently (2.4/2.6) regardless' },
  { file: 'src/staleness/pass.ts', line: 97, kind: 'exempt', standing: 'exempt: staleness_checked_at only, no tags column' },
  // NEW (T-0089.1.1 close-out): the nightly vectorize-pending pass's batched vector_ids CAS, as storeEntry's.
  // MOVED 78 -> 89 (T-0089.1.1 round 3): the pass plans from lengths, then reads the chosen rows.
  // MOVED 89 -> 93 (T-0089.1.1 round 5): indexPendingRow reports whether its commit landed.
  // MOVED 93 -> 131 (T-0089.1.1 round 5): failure counting and demotion above the batch; same site.
  // MOVED 131 -> 151 (T-0089.1.1, budget auditor R11): the 128 KB nightly cap and its skip count.
  { file: 'src/vectorize/pending.ts', line: 165, kind: 'exempt', standing: 'exempt: vector_ids only, no tags column' },
  // MOVED 367 -> 368 (T-0089.2.1): candidateSql's now parameter shifted this by one line; same site.
  { file: 'src/when/pass.ts', line: 368, kind: 'exempt', standing: 'exempt: when_* only, no tags column' },
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
  "src/capture/classify.ts:78", "src/routes/admin.ts:1564", // /classify-pending and applyClassification (hygiene)
  // captureEntry retags its OWN new row before returning, while it has no version chain yet
  // (design row 18): the caller sees the final tags in the same response, nothing to undo.
  "src/capture/entry.ts:540", "src/capture/entry.ts:601",
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
