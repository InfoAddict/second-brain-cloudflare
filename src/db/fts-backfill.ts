import { FTS_BACKFILL_BATCH, FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../constants";
import type { Env } from "../env";
import { isFtsLive } from "../recall/fts";

// Resumable nightly backfill for rows that predate entries_fts. Trigger-covered
// rows are handled too: each batch deletes its rowid range before inserting, so
// re-running over them is a no-op rather than a duplicate (FTS5 has no ON
// CONFLICT). Keyed on entries.rowid — the same rowid the triggers mirror.
// Batch size bounds FTS shadow-row writes against the 100k/day cap.
export async function runFtsBackfill(env: Env): Promise<{ indexed: number; done: boolean }> {
  if ((await env.OAUTH_KV.get(FTS_READY_KV_KEY)) === "1") return { indexed: 0, done: true };
  // Write-path isolation v2.2 INVARIANT: FTS is live only if entries_fts
  // exists AND all three sync triggers exist. A hot-path repair can leave it
  // not live (table missing, or a trigger dropped) with no KV write at all.
  // Only rebuildFtsIndex (Task 5, nightly) may recreate it. Without this
  // check the DELETE+INSERT batch below would throw "no such table:
  // entries_fts" into src/index.ts's catch every night (or, on a night with
  // no backlog rows, worse: latch ready="1" over an index that is not live).
  // Skip cleanly and log once instead.
  if (!(await isFtsLive(env))) {
    console.error("FTS backfill skipped: entries_fts is not live (missing table or a sync trigger), waiting for the nightly rebuild");
    return { indexed: 0, done: false };
  }
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

// Single nightly entry point. In this task it only backfills; Task 5 adds the
// ready-state integrity branch here, so src/index.ts never changes again.
// The statements write to entries_fts directly, so the entries write guard does
// not wrap them (by design). If entries_fts is missing when one runs, it
// throws; src/index.ts catches it and the nightly logs non-fatal.
export async function runFtsMaintenance(env: Env): Promise<{ indexed: number; done: boolean }> {
  return runFtsBackfill(env);
}
