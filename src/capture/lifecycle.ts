import type { Env } from "../env";
import { withStatus, type MemoryStatus } from "../memory/status";
import { deleteVectorIds } from "../vectorize/batch";
import type { Config } from "../config";
import type { ChangeContext } from "../lib/audit";
import { buildCasGuard, changesOf, Params, pruneStatement, snapshotStatement } from "../memory/versions";
import { TRASH_PURGE_ON_FORGET, FORGET_PURGE_ROWS } from "../constants";
import { planTrash, purgeLimit, purgeTrash, readTrashCandidates, trashManyStatements, type TrashReason } from "../memory/trash";

export type ForgetResult =
  | { status: "not_found" }
  | { status: "deleted"; vectorCount: number; trashed: boolean; edgesDropped: boolean };

export interface ForgetOptions {
  reason: TrashReason;
  config: Readonly<Config>;
  /** Run one bounded purge batch afterwards. Mirror and disconnect pass false: they audit and bound their own work. */
  purge?: boolean;
  /** Trash row budget in bytes; tests shrink it to reach the fallback tiers. */
  budget?: number;
}

/**
 * Forget moves the entry to the trash: one batch inserts the trash row (with its edges), then
 * deletes the edges and the entry. An entry too large for the trash is hard deleted, versions
 * included. `not_found` when the batch's entry delete removed nothing (a racing deleter won).
 */
export async function forgetEntry(
  id: string, env: Env, change: ChangeContext, opts: ForgetOptions,
  /** The workspace the caller's own scoped read authorized (R2-3): a row that moved out of it in
   * the awaited gap between that read and this call's own is not this caller's to trash, even
   * though readTrashCandidates (by-id, trash.ts) would otherwise still find it. */
  authorizedWorkspaceId: string,
): Promise<ForgetResult> {
  const [row] = await readTrashCandidates(env, [id]);
  if (!row) return { status: "not_found" };
  // A legacy row's workspace_id column can be null/undefined rather than "" (readTrashCandidates
  // reads it raw); the caller's own scoped read normalizes the same way, so pin against that, not
  // the raw column value, or a legitimate legacy row's forget always reports not_found.
  if ((row.workspace_id ?? "") !== (authorizedWorkspaceId ?? "")) return { status: "not_found" };

  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
  const plan = planTrash([row], opts.budget);
  const stmts = trashManyStatements(env, plan, { reason: opts.reason, change, now: Date.now() });
  const results = await env.DB.batch(stmts);
  // A racing deleter removed it between the read and the batch: it owns the cleanup and the audit.
  if (changesOf(results[results.length - 1]) === 0) return { status: "not_found" };

  try {
    if (vectorIds.length) await deleteVectorIds(env, vectorIds);
  } catch (e) {
    console.error("Vectorize delete failed (non-fatal):", e);
  }

  if (opts.purge !== false) {
    try {
      await purgeTrash(env, opts.config, {
        ceiling: purgeLimit(opts.config.VERSION_KEEP, TRASH_PURGE_ON_FORGET, FORGET_PURGE_ROWS),
        rowTarget: FORGET_PURGE_ROWS,
      });
    } catch (e) {
      console.error("Trash purge failed (non-fatal):", e);
    }
  }

  return { status: "deleted", vectorCount: vectorIds.length, trashed: plan.tier3.length === 0, edgesDropped: plan.tier2.length > 0 };
}

/**
 * SQL for "this entry is still supposed to be in the index".
 *
 * `deprecateEntry` empties `vector_ids` and deletes the vectors on purpose, so
 * an empty `vector_ids` means one of two opposite things: an entry that failed
 * to embed and should be retried, or one that was deliberately taken out of the
 * index and must not be. Reading it as only the first is how dismissing a
 * pattern raised the "not searchable" count and then re-embedded the very thing
 * the user had just dismissed when they pressed "Vectorize now".
 *
 * This lives beside the function that creates the state, so anything counting
 * or repairing unindexed entries can recognise it. (`vector_ids` is named bare
 * here on purpose — test/unit/updated-at-coalesced.test.ts reads every
 * backtick-delimited span in src/ as SQL, comments included.)
 */
export const INDEXABLE_SQL = `tags NOT LIKE '%"status:deprecated"%'`;

/**
 * `workspaceId` pins both the read and the write to it (R2-3): a row that moved since the caller's
 * own scoped read, in the awaited gap before this call's own read, is left alone and false is
 * returned. Required so a new caller cannot forget it; routes pass the workspace getReadableEntry
 * just authorized, captureEntry passes the writer's own.
 */
export async function deprecateEntry(
  id: string,
  env: Env,
  change: ChangeContext,
  config: Readonly<Config>,
  workspaceId: string,
  opts: { meta?: Record<string, unknown> } = {},
): Promise<boolean> {
  // A route's own scoped read can carry workspace_id as null/undefined for a legacy row; SQL NULL
  // never equals another NULL via `=`, so an un-normalized pin would fail this read and every
  // later write forever, even against the row's own real state. Coalesce to "" like every other
  // read of this column.
  const pinnedWorkspaceId = workspaceId ?? "";
  const row = await env.DB.prepare(
    `SELECT tags, vector_ids FROM entries WHERE id = ? AND workspace_id = ?`
  ).bind(id, pinnedWorkspaceId).first() as Record<string, any> | null;
  if (!row) return false;

  const tags: string[] = JSON.parse(row.tags ?? "[]");
  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
  const deprecatedTags = withStatus(tags, "deprecated");
  const casColumns = { workspace_id: pinnedWorkspaceId };

  const results = await env.DB.batch([
    snapshotStatement(env, {
      entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags: deprecatedTags, meta: opts.meta, now: Date.now(),
      guard: p => buildCasGuard(p, casColumns),
    }),
    (() => {
      const p = new Params();
      const tagsIdx = p.add(JSON.stringify(deprecatedTags));
      const idIdx = p.add(id);
      // versioning: snapshot
      return env.DB.prepare(`UPDATE entries AS e SET tags = ${tagsIdx}, vector_ids = '[]' WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values());
    })(),
    pruneStatement(env, id, config.VERSION_KEEP),
  ]);
  if (changesOf(results[1]) === 0) return false;

  try {
    if (vectorIds.length) await deleteVectorIds(env, vectorIds);
  } catch (e) {
    console.error("Vectorize deleteByIds failed during deprecate (non-fatal):", e);
  }
  return true;
}

export async function applyStatus(id: string, status: MemoryStatus, env: Env, change: ChangeContext, config: Readonly<Config>, workspaceId: string): Promise<boolean> {
  if (status === "deprecated") return deprecateEntry(id, env, change, config, workspaceId, { meta: { status } });
  // R2-3: pinned to the caller's authorized workspace, same reasoning as deprecateEntry above
  // (including its null/undefined normalization for a legacy row's column value).
  const pinnedWorkspaceId = workspaceId ?? "";
  const row = await env.DB.prepare(`SELECT tags FROM entries WHERE id = ? AND workspace_id = ?`).bind(id, pinnedWorkspaceId).first() as Record<string, any> | null;
  if (!row) return false;
  const nextTags = withStatus(JSON.parse(row.tags ?? "[]") as string[], status);
  const casColumns = { workspace_id: pinnedWorkspaceId };
  // A status set to what the row already has (tags may merely reorder) writes no version.
  const p = new Params();
  const tagsIdx = p.add(JSON.stringify(nextTags));
  const idIdx = p.add(id);
  const results = await env.DB.batch([
    snapshotStatement(env, {
      entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags, meta: { status }, now: Date.now(),
      guard: p2 => buildCasGuard(p2, casColumns),
    }),
    // versioning: snapshot
    env.DB.prepare(`UPDATE entries AS e SET tags = ${tagsIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values()),
    pruneStatement(env, id, config.VERSION_KEEP),
  ]);
  return changesOf(results[1]) > 0;
}
