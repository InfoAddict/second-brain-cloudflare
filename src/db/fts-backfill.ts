import {
  FTS_BACKFILL_BATCH, FTS_BACKFILL_CURSOR_KV_KEY, FTS_INTEGRITY_SPOT_CHECK, FTS_READY_KV_KEY,
} from "../constants";
import type { Env } from "../env";
import { isFtsLive } from "../recall/fts";
import { rebuildFtsIndex } from "./fts-repair";

// Resumable nightly backfill for rows that predate entries_fts. Trigger-covered
// rows are handled too: each batch deletes its rowid range before inserting, so
// re-running over them is a no-op rather than a duplicate (FTS5 has no ON
// CONFLICT). Keyed on entries.rowid — the same rowid the triggers mirror.
// Batch size bounds FTS shadow-row writes against the 100k/day cap.
export async function runFtsBackfill(env: Env): Promise<{ indexed: number; done: boolean }> {
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
  if (!(await isFtsLive(env))) {
    console.error("FTS backfill skipped: entries_fts is not live (missing table, a sync trigger, or a trigger with an unexpected body), waiting for the nightly rebuild");
    return { indexed: 0, done: false };
  }
  if ((await env.OAUTH_KV.get(FTS_READY_KV_KEY)) === "1") return { indexed: 0, done: true };
  const cursor = Number(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY) ?? "0");
  // scope-exempt: cron: nightly backfill keyed on rowid — rowids are unravelled
  // throughout (schema comment on similar.) so there is no workspace scope to
  // apply; the index exists deployment-wide and the ready gate keeps it hidden
  // from recall until it covers every row in every workspace.
  const { results } = await env.DB.prepare(
    `SELECT rowid AS rid FROM entries WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  ).bind(cursor, FTS_BACKFILL_BATCH).all<{ rid: number }>();
  if (!results.length) {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    return { indexed: 0, done: true };
  }
  const last = results[results.length - 1].rid;
  await env.DB.batch([
    // scope-exempt: cron: the same nightly backfill as the SELECT above — the
    // FTS shadow is mirrored per rowid across every workspace, and writing a
    // rowid-keyed range leaves no row's content unsynced or cross-read.
    env.DB.prepare(
      `DELETE FROM entries_fts WHERE rowid IN (SELECT rowid FROM entries WHERE rowid > ? AND rowid <= ?)`,
    ).bind(cursor, last),
    // scope-exempt: cron: INSERT..SELECT of the same rowid range as the DELETE
    // above; the source rows' content moves into the index, it is not returned.
    env.DB.prepare(
      `INSERT INTO entries_fts (rowid, id, content) SELECT rowid, id, content FROM entries WHERE rowid > ? AND rowid <= ?`,
    ).bind(cursor, last),
  ]);
  await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, String(last));
  const done = results.length < FTS_BACKFILL_BATCH;
  if (done) await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
  return { indexed: results.length, done };
}

// Nightly drift detector, run only once the backfill has latched ready. Count
// parity catches missed triggers and partial batches; the spot check catches
// rowid renumbering, which keeps counts equal while breaking the mapping.
// Repair is a reset, not a rebuild: delete orphans (the backfill's own
// delete-range-then-insert batches cover rowids present in entries, so
// orphans would survive them otherwise), then clear the cursor and ready flag
// so the ordinary backfill re-covers the corpus over the following nights.
export async function checkFtsIntegrity(env: Env): Promise<{ healthy: boolean }> {
  // scope-exempt: cron: deployment-wide parity check, like the backfill above —
  // the index has no per-workspace shape, so there is no workspace scope to apply.
  const counts = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM entries) AS e, (SELECT count(*) FROM entries_fts) AS f`,
  ).first<{ e: number; f: number }>();
  let healthy = counts !== null && counts.e === counts.f;
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
  }
  return { healthy };
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
    return runFtsBackfill(env);
  }
  try {
    await env.DB.prepare(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`).run();
  } catch (e) {
    console.error("FTS integrity-check statement failed; rebuilding:", e);
    await rebuildFtsIndex(env);
    return runFtsBackfill(env);
  }
  if ((await env.OAUTH_KV.get(FTS_READY_KV_KEY)) !== "1") {
    return runFtsBackfill(env);
  }
  const { healthy } = await checkFtsIntegrity(env);
  return { indexed: 0, done: healthy };
}
