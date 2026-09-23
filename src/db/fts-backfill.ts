import {
  D1_MAX_BOUND_PARAMS, FTS_BACKFILL_BATCH, FTS_BACKFILL_CURSOR_KV_KEY, FTS_CONTENT_CHECK_CURSOR_KV_KEY,
  FTS_CONTENT_CHECK_WINDOW, FTS_INTEGRITY_SPOT_CHECK, FTS_READY_KV_KEY,
} from "../constants";
import type { Env } from "../env";
import { FTS_LIVENESS_SQL, isFtsLive, isFtsLiveRows } from "../recall/fts";
import { rebuildFtsIndex } from "./fts-repair";
import {
  ENTRY_COUNTS_INSERT_TRIGGER_DDL, ENTRY_COUNTS_UPDATE_TRIGGER_DDL, ENTRY_COUNTS_DELETE_TRIGGER_DDL,
} from "./init";

// T-0065 nightly check (FIX 1, final review): mirrors the FTS liveness
// pattern above — a right-named entry_counts trigger with a tampered body
// (or one silently dropped and never recreated) is not "healthy" just
// because a trigger by that name exists in sqlite_master.
const ENTRY_COUNTS_TRIGGER_LIVENESS_SQL =
  `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND ` +
  `name IN ('entry_counts_insert','entry_counts_update','entry_counts_delete')`;
const EXPECTED_ENTRY_COUNTS_TRIGGER_DEFINITIONS: Record<string, string> = {
  entry_counts_insert: ENTRY_COUNTS_INSERT_TRIGGER_DDL.replace(/\bIF NOT EXISTS\s+/i, ""),
  entry_counts_update: ENTRY_COUNTS_UPDATE_TRIGGER_DDL.replace(/\bIF NOT EXISTS\s+/i, ""),
  entry_counts_delete: ENTRY_COUNTS_DELETE_TRIGGER_DDL.replace(/\bIF NOT EXISTS\s+/i, ""),
};
function entryCountsTriggersLive(rows: { name: string; sql: string | null }[] | undefined): boolean {
  if (!rows || rows.length !== 3) return false;
  return rows.every(row => EXPECTED_ENTRY_COUNTS_TRIGGER_DEFINITIONS[row.name] === row.sql);
}

// Ready-latch guard (combined review of Tasks 4-6): the old latch fired on
// "the cursor found no rows" alone, so a cursor past max rowid — or a sync
// trigger dropped mid-batch — latched ready="1" over an incomplete index.
// Before any latch, ONE batch re-checks liveness together with exact parity
// in both directions; a single mismatching row anywhere restarts the
// backfill instead of marking it done.
// scope-exempt: cron: the latch guard's deployment-wide parity read, keyed on
// rowid like the backfill itself — the index has no per-workspace shape.
const FTS_LATCH_PARITY_FORWARD_SQL =
  `SELECT 1 FROM (SELECT rowid, id, content FROM entries EXCEPT SELECT rowid, id, content FROM entries_fts) LIMIT 1`;
// scope-exempt: cron: the reverse direction of the same parity pair.
const FTS_LATCH_PARITY_REVERSE_SQL =
  `SELECT 1 FROM (SELECT rowid, id, content FROM entries_fts EXCEPT SELECT rowid, id, content FROM entries) LIMIT 1`;

async function readyLatchAllowed(env: Env): Promise<boolean> {
  const [liveness, forward, reverse] = await env.DB.batch([
    // scope-exempt: FTS_LIVENESS_SQL reads sqlite_master (schema catalogue) — nothing here to scope by workspace.
    env.DB.prepare(FTS_LIVENESS_SQL),
    // scope-exempt: cron: deployment-wide parity keyed on rowid, like the backfill itself — the index has no per-workspace shape.
    env.DB.prepare(FTS_LATCH_PARITY_FORWARD_SQL),
    env.DB.prepare(FTS_LATCH_PARITY_REVERSE_SQL),
  ]);
  return isFtsLiveRows(liveness.results as { name: string; sql: string | null }[] | undefined)
    && !forward.results.length && !reverse.results.length;
}

// One backfill night. The caller may already know liveness and readiness
// (runFtsMaintenance checks both itself) — threading them through avoids
// paying for the same liveness query and ready read twice per night.
async function backfillStep(env: Env, known: { live: boolean; ready: boolean }): Promise<{ indexed: number; done: boolean }> {
  // Write-path isolation v2.2 INVARIANT: FTS is live only if entries_fts
  // exists AND all three sync triggers exist, with their exact bodies.
  // Checked FIRST (M1, v2.2 re-review) — a hot-path repair can leave the
  // index not live (table missing, a trigger dropped, or a stale body) with
  // no KV write at all, so a stale ready="1" left over from before that
  // repair must never short-circuit past this. Only rebuildFtsIndex (Task 5,
  // nightly) may recreate it. Without this check the DELETE+INSERT batch
  // below would throw "no such table: entries_fts" into src/index.ts's
  // catch every night (or, on a night with no backlog rows, worse: latch
  // ready="1" over an index that is not live). Skip cleanly and log once.
  if (!known.live) {
    console.error("FTS backfill skipped: entries_fts is not live (missing table, a sync trigger, or a trigger with an unexpected body), waiting for the nightly rebuild");
    return { indexed: 0, done: false };
  }
  if (known.ready) return { indexed: 0, done: true };
  const cursor = Number(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY) ?? "0");
  // scope-exempt: cron: nightly backfill keyed on rowid — rowids are unravelled
  // throughout (schema comment on similar.) so there is no workspace scope to
  // apply; the index exists deployment-wide and the ready gate keeps it hidden
  // from recall until it covers every row in every workspace.
  const { results } = await env.DB.prepare(
    `SELECT rowid AS rid FROM entries WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  ).bind(cursor, FTS_BACKFILL_BATCH).all<{ rid: number }>();
  if (!results.length) {
    if (await readyLatchAllowed(env)) {
      await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
      return { indexed: 0, done: true };
    }
    await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, "0");
    return { indexed: 0, done: false };
  }
  const last = results[results.length - 1].rid;
  await env.DB.batch([
    // scope-exempt: cron: the same nightly backfill as the SELECT above — the
    // FTS shadow is mirrored per rowid across every workspace, and writing a
    // rowid-keyed range leaves no row's content unsynced or cross-read.
    env.DB.prepare(`DELETE FROM entries_fts WHERE rowid > ? AND rowid <= ?`).bind(cursor, last),
    env.DB.prepare(`INSERT INTO entries_fts (rowid, id, content) SELECT rowid, id, content FROM entries WHERE rowid > ? AND rowid <= ?`).bind(cursor, last),
  ]);
  await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, String(last));
  if (results.length < FTS_BACKFILL_BATCH) {
    if (await readyLatchAllowed(env)) {
      await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
      return { indexed: results.length, done: true };
    }
    // The latch guard refused: restart from the top next night rather than
    // serve an index that just failed exact parity as complete.
    await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, "0");
    return { indexed: results.length, done: false };
  }
  return { indexed: results.length, done: false };
}

// Resumable nightly backfill for rows that predate entries_fts. Trigger-covered
// rows are handled too: each batch deletes its rowid range before inserting, so
// re-running over them is a no-op rather than a duplicate (FTS5 has no ON
// CONFLICT). Keyed on entries.rowid — the same rowid the triggers mirror.
// Batch size bounds FTS shadow-row writes against the 100k/day cap.
export async function runFtsBackfill(env: Env): Promise<{ indexed: number; done: boolean }> {
  const live = await isFtsLive(env);
  const ready = live && (await env.OAUTH_KV.get(FTS_READY_KV_KEY)) === "1";
  return backfillStep(env, { live, ready });
}

// Nightly drift detector, run only once the backfill has latched ready. Count
// parity catches missed triggers and partial batches; the spot check catches
// rowid renumbering, which keeps counts equal while breaking the mapping.
// Repair is a reset, not a rebuild: delete orphans (the backfill's own
// delete-range-then-insert batches cover rowids present in entries, so
// orphans would survive them otherwise), then clear the cursor and ready flag
// so the ordinary backfill re-covers the corpus over the following nights.
// This is where orphans are found now: with the window's orphan half gone
// (see rotateContentCheck), an orphan surfaces only as fts > entries here.
// An exactly canceling missing+orphan pair heals within
// ceil(N / FTS_CONTENT_CHECK_WINDOW) + 1 nights; a global probe would double
// nightly reads for a near-impossible case, so that delay is accepted.
export async function checkFtsIntegrity(env: Env): Promise<{ healthy: boolean }> {
  // Nightly drift detector's totals. max(rowid) bounds the rotating window's
  // wrap; the global entries total is summed in JS from the GROUP BY in the
  // batch below, so no count(*) over entries is needed here.
  // scope-exempt: cron: deployment-wide parity check, like the backfill above —
  // no per-workspace shape.
  const counts = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM entries_fts) AS f, (SELECT max(rowid) FROM entries) AS mx`,
  ).first<{ f: number; mx: number | null }>();

  // T-0065 (FIX 1, final review): per-workspace parity, not a global SUM —
  // a global total can equal count(*) even when one workspace's counter
  // drifted from another's (a missing entry_counts_update trigger plus a
  // cross-workspace move nets to zero globally, which the old global check
  // read as healthy forever). The GROUP BY is the ONLY full scan of entries
  // this night pays: the entries-vs-fts count parity consumes its summed
  // total. Batched with the entry_counts read and the trigger-definition
  // check so this whole probe still costs one D1 call.
  const [entriesByWorkspace, cachedByWorkspace, triggerRows] = await env.DB.batch([
    // scope-exempt: cron: deployment-wide parity read, like the backfill and
    // the count(*) above — every workspace's own row, by design, not a
    // response any one caller reads.
    env.DB.prepare(`SELECT workspace_id, count(*) AS n FROM entries GROUP BY workspace_id`),
    env.DB.prepare(`SELECT workspace_id, n FROM entry_counts`),
    env.DB.prepare(ENTRY_COUNTS_TRIGGER_LIVENESS_SQL),
  ]);
  const actualByWorkspace = new Map((entriesByWorkspace.results as { workspace_id: string; n: number }[]).map(r => [r.workspace_id, r.n]));
  const cachedByWorkspaceMap = new Map((cachedByWorkspace.results as { workspace_id: string; n: number }[]).map(r => [r.workspace_id, r.n]));
  // The global entries total, summed from the GROUP BY — the parity check
  // below consumes it, so no second full scan of entries happens tonight.
  const totalEntries = (entriesByWorkspace.results as { n: number }[]).reduce((sum, r) => sum + r.n, 0);
  // Bidirectional: a workspace present on only one side (moved away entirely,
  // or a stale counter row for a workspace with zero live entries) is a
  // mismatch too — treat the missing side as 0.
  const allWorkspaces = new Set([...actualByWorkspace.keys(), ...cachedByWorkspaceMap.keys()]);
  let countersDrifted = false;
  for (const ws of allWorkspaces) {
    if ((actualByWorkspace.get(ws) ?? 0) !== (cachedByWorkspaceMap.get(ws) ?? 0)) { countersDrifted = true; break; }
  }
  const triggersLive = entryCountsTriggersLive(triggerRows.results as { name: string; sql: string | null }[] | undefined);

  // entry_counts repair, independent of the entries_fts branch below — a
  // missed trigger, a tampered trigger body, or a partial batch failure can
  // drift one without the other. Repair is a reset, not a patch: drop and
  // recreate the three triggers, DELETE, and reseed from the GROUP BY above,
  // in ONE atomic batch, mirroring the shape applySchema uses to build it
  // the first time — applySchema itself never repairs triggers on an
  // existing table, so this nightly check is the only place that does.
  if (countersDrifted || !triggersLive) {
    console.error("entry_counts drift detected (per-workspace mismatch or a tampered trigger); rebuilding");
    await env.DB.batch([
      env.DB.prepare(`DROP TRIGGER IF EXISTS entry_counts_insert`),
      env.DB.prepare(`DROP TRIGGER IF EXISTS entry_counts_update`),
      env.DB.prepare(`DROP TRIGGER IF EXISTS entry_counts_delete`),
      env.DB.prepare(ENTRY_COUNTS_INSERT_TRIGGER_DDL),
      env.DB.prepare(ENTRY_COUNTS_UPDATE_TRIGGER_DDL),
      env.DB.prepare(ENTRY_COUNTS_DELETE_TRIGGER_DDL),
      env.DB.prepare(`DELETE FROM entry_counts`),
      // scope-exempt: cron: deployment-wide rebuild, like the backfill above —
      // entry_counts itself carries every workspace's row by design.
      env.DB.prepare(`INSERT INTO entry_counts SELECT workspace_id, count(*) FROM entries GROUP BY workspace_id`),
    ]);
  }

  let healthy = counts !== null && totalEntries === counts.f;
  if (healthy) {
    // scope-exempt: cron: same rowid-keyed, deployment-wide check as the count above.
    const { results } = await env.DB.prepare(
      `SELECT e.id AS eid, f.id AS fid FROM entries e LEFT JOIN entries_fts f ON f.rowid = e.rowid ORDER BY e.rowid DESC LIMIT ?`,
    ).bind(FTS_INTEGRITY_SPOT_CHECK).all<{ eid: string; fid: string | null }>();
    healthy = results.every(r => r.fid === r.eid);
  }
  if (!healthy) {
    console.error("FTS integrity check failed; resetting backfill");
    // scope-exempt: cron: orphan cleanup keyed on rowid presence in entries, not
    // on any single workspace's rows.
    await env.DB.prepare(`DELETE FROM entries_fts WHERE rowid NOT IN (SELECT rowid FROM entries)`).run();
    await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, "0");
    await env.OAUTH_KV.delete(FTS_READY_KV_KEY);
    return { healthy };
  }
  await rotateContentCheck(env, counts!.mx);
  return { healthy };
}

// Rotating content check (combined review of Tasks 4-6): count parity and the
// newest-few spot check cannot see same-row content drift — equal counts,
// identical ids. Each night reads the next FTS_CONTENT_CHECK_WINDOW rowids
// behind FTS_CONTENT_CHECK_CURSOR_KV_KEY, compares (rowid, id, content) both
// ways, and re-indexes exactly the mismatched rowids IN PLACE — no backfill
// reset, ready stays set. The cursor advances one window per night and wraps
// to 0 once it passes the corpus's max rowid, so every row is re-checked
// within ceil(N / FTS_CONTENT_CHECK_WINDOW) nights.
//
// Orphans (fts rowids absent from entries) are NOT scanned here. The window
// used to carry an orphan half anti-joined to entries, but on real D1 FTS5
// does not honor rowid range constraints as seeks — the plan shows
// INDEX 0:>< while the run meters a whole-virtual-table read (measured
// 20,961 rows_read at 20.8k entries) — so orphans ride on count parity
// instead: checkFtsIntegrity's DELETE fires on the next night the counts
// differ (fts > entries). A missing mirror paired with an orphan cancels in
// the count for one night; the drift half re-indexes the missing row, and
// the next night's parity cleans the orphan.
async function rotateContentCheck(env: Env, maxRowid: number | null): Promise<void> {
  const cursor = Number(await env.OAUTH_KV.get(FTS_CONTENT_CHECK_CURSOR_KV_KEY) ?? "0");
  const hi = cursor + FTS_CONTENT_CHECK_WINDOW;
  // The window must never meter a bare
  // `SELECT rowid, id, content FROM entries_fts WHERE rowid > ? AND rowid <= ?`
  // — a full virtual-table scan on D1 (rows_read = corpus size). The drift
  // half drives from entries' rowid range and reads FTS by exact rowid (FTS5
  // pushes `rowid = ?` through as VIRTUAL TABLE INDEX 0:=).
  const [drifted] = await env.DB.batch([
    // scope-exempt: cron: same rowid-keyed, deployment-wide parity read as the checks above — the window carries no workspace shape.
    env.DB.prepare(`SELECT e.rowid AS rowid FROM entries e LEFT JOIN entries_fts f ON f.rowid = e.rowid WHERE e.rowid > ? AND e.rowid <= ? AND (f.rowid IS NULL OR f.id IS NOT e.id OR f.content IS NOT e.content)`).bind(cursor, hi),
  ]);
  const rowids = (drifted.results as { rowid: number }[])
    .map(r => r.rowid).sort((a, b) => a - b);
  if (rowids.length) {
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < rowids.length; i += D1_MAX_BOUND_PARAMS) {
      const chunk = rowids.slice(i, i + D1_MAX_BOUND_PARAMS);
      const markers = chunk.map(() => "?").join(",");
      statements.push(env.DB.prepare(`DELETE FROM entries_fts WHERE rowid IN (${markers})`).bind(...chunk));
      // scope-exempt: cron: in-place re-index for exactly the rowids the
      // window probe flagged, deployment-wide like the backfill itself.
      statements.push(env.DB.prepare(
        `INSERT INTO entries_fts (rowid, id, content) SELECT rowid, id, content FROM entries WHERE rowid IN (${markers})`,
      ).bind(...chunk));
    }
    await env.DB.batch(statements);
  }
  await env.OAUTH_KV.put(FTS_CONTENT_CHECK_CURSOR_KV_KEY, String(maxRowid === null || hi >= maxRowid ? 0 : hi));
}

// Single nightly entry point. Write-path isolation v2.2: a live request never
// destroys the index; only this nightly job rebuilds. Not live (table or any
// sync trigger missing or drifted from its expected body) means a hot-path
// repair left it disabled — rebuildFtsIndex is the only place that DROP/
// CREATEs entries_fts, and the backfill starts the same night so the outage
// is not compounded by a second night of waiting. Live: FTS5's own
// integrity-check is the corruption probe count parity cannot see; a throw
// there also rebuilds. Otherwise, ready not yet latched means the backfill is
// still in progress, so the parity checks below are skipped until it is.
export async function runFtsMaintenance(env: Env): Promise<{ indexed: number; done: boolean }> {
  if (!(await isFtsLive(env))) {
    await rebuildFtsIndex(env);
    // The rebuild's own batch either recreated the table and triggers or
    // threw, so the index is live here, and its KV invalidation already
    // cleared ready and reset the cursor.
    return backfillStep(env, { live: true, ready: false });
  }
  try {
    await env.DB.prepare(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`).run();
  } catch (e) {
    console.error("FTS integrity-check statement failed; rebuilding:", e);
    await rebuildFtsIndex(env);
    return backfillStep(env, { live: true, ready: false });
  }
  const ready = (await env.OAUTH_KV.get(FTS_READY_KV_KEY)) === "1";
  if (!ready) return backfillStep(env, { live: true, ready });
  const { healthy } = await checkFtsIntegrity(env);
  return { indexed: 0, done: healthy };
}
