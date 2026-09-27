import type { Env } from "../env";
import { resolveConfig, type Config } from "../config";
import {
  MEMBER_REMOVAL_NIGHTLY_MAX, NIGHTLY_CLEANUP_ROWS, TRASH_PURGE_BATCH_ROWS, TRASH_PURGE_NIGHTLY,
  TRASH_PURGE_NIGHTLY_MAX_BATCHES, TRASH_PURGE_NIGHTLY_ROWS,
} from "../constants";
import { writeAdminEvent } from "../lib/admin-audit";
import { cleanupMemberData, findPendingRemoval } from "../lib/team-admin";
import { deleteVectorIds } from "../vectorize/batch";
import { purgeTrash } from "./trash";

export interface NightlyCleanupResult {
  purged: number;
  /** Rows written by the purge and the removal resume together; never above NIGHTLY_CLEANUP_ROWS (bar one oversized final batch). */
  rowsWritten: number;
  removalResumed: boolean;
}

/**
 * The one pending removal `allowOversize` deferred (its own last-mile final batch alone did not
 * fit what the purge left of the night's budget) — keyed by userId, so a stale flag from an
 * already-finished removal cannot force oversize for an unrelated one that has not even tried the
 * ordinary path yet. KV, not D1: it costs nothing against the nightly's own execution pin.
 *
 * On an active brain the purge writes something every night, so `allowOversize: purgeRows === 0`
 * alone never fires again once a removal's final batch is bigger than what is left — the removal
 * waits forever, not just some nights (T-0089.7.5). This is its guaranteed slot: the night after a
 * removal is turned away at the size gate, it forces allowOversize regardless of what the purge
 * did, so the wait is at most one night, not indefinite.
 */
const REMOVAL_DEFERRED_KV_KEY = "cleanup:removal-deferred";

/**
 * Nightly cleanup with one rows-written budget shared in order: the trash purge (at most
 * TRASH_PURGE_NIGHTLY_MAX_BATCHES batches, TRASH_PURGE_NIGHTLY_ROWS of the budget), then the
 * resume of one pending member removal with what is left. An ordinary night costs two D1
 * executions: the purge's candidate read and the removal probe.
 */
export async function runNightlyCleanup(env: Env): Promise<NightlyCleanupResult> {
  // Resolved only if the purge finds something old enough to need the retention window.
  let cfg: Promise<Readonly<Config>> | null = null;
  const config = () => (cfg ??= resolveConfig(env));
  let purged = 0;
  let purgeRows = 0;

  try {
    for (let i = 0; i < TRASH_PURGE_NIGHTLY_MAX_BATCHES; i++) {
      const r = await purgeTrash(env, config, {
        ceiling: TRASH_PURGE_NIGHTLY,
        rowTarget: TRASH_PURGE_BATCH_ROWS,
        rowsLeft: TRASH_PURGE_NIGHTLY_ROWS - purgeRows,
      });
      purged += r.purged;
      purgeRows += r.rowsWritten;
      // Stop at the first batch that read nothing, or that purged less than it read for a reason
      // OTHER than the row budget: a budget cut means more expired rows are still waiting, so the
      // loop must keep going (stopping here halved the spec's purge pacing, ADV-trash-8).
      if (r.read === 0 || (r.purged < r.read && r.trimmed === 0 && !r.budgetCut)) break;
    }
  } catch (e) {
    console.error("Trash purge failed (non-fatal):", e);
  }

  let removalRows = 0;
  let removalResumed = false;
  try {
    for (let n = 0; n < MEMBER_REMOVAL_NIGHTLY_MAX; n++) {
      const pending = await findPendingRemoval(env);
      if (!pending) break;
      removalResumed = true;
      let forceOversize = false;
      try { forceOversize = (await env.OAUTH_KV.get(REMOVAL_DEFERRED_KV_KEY)) === pending.userId; } catch (e) {
        console.error("Removal-deferred flag read failed (non-fatal):", e);
      }
      const res = await cleanupMemberData(env, pending.userId, pending.personalWid, {
        rowsLeft: NIGHTLY_CLEANUP_ROWS - purgeRows,
        allowOversize: purgeRows === 0 || forceOversize,
      });
      removalRows += res.rowsWritten ?? 0;
      try {
        if (res.blockedByBudget) await env.OAUTH_KV.put(REMOVAL_DEFERRED_KV_KEY, pending.userId);
        else await env.OAUTH_KV.delete(REMOVAL_DEFERRED_KV_KEY);
      } catch (e) {
        console.error("Removal-deferred flag write failed (non-fatal):", e);
      }
      if (!res.done) break;
      if (res.vectorIds.length) {
        try { await deleteVectorIds(env, res.vectorIds); } catch (e) { console.error("Vectorize deleteByIds failed during member removal resume (non-fatal):", e); }
      }
      await writeAdminEvent(env, {
        actorId: "",
        targetUserId: pending.userId,
        event: "member_removed",
        payload: { removedEntries: res.removedEntries, removedVectors: res.vectorIds.length, resumed: true },
      });
    }
  } catch (e) {
    console.error("Member removal resume failed (non-fatal):", e);
  }

  return { purged, rowsWritten: purgeRows + removalRows, removalResumed };
}
