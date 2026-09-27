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
      const res = await cleanupMemberData(env, pending.userId, pending.personalWid, {
        rowsLeft: NIGHTLY_CLEANUP_ROWS - purgeRows,
        allowOversize: purgeRows === 0,
      });
      removalRows += res.rowsWritten ?? 0;
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
