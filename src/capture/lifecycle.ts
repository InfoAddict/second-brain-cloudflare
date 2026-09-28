import type { Env } from "../env";
import { getStatus, withStatus, type MemoryStatus } from "../memory/status";
import { deleteEntryVectors } from "../vectorize/batch";
import { reembedOrDegrade, discardUpload } from "./store";
import type { Config } from "../config";
import type { ChangeContext } from "../lib/audit";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import { buildCasGuard, changesOf, Params, pruneStatement, snapshotStatement } from "../memory/versions";
import { TRASH_PURGE_ON_FORGET, FORGET_PURGE_ROWS } from "../constants";
import { planTrash, purgeLimit, purgeTrash, readTrashCandidates, trashHookOffset, trashManyStatements, type TrashReason } from "../memory/trash";
import {
  auditValidity, NO_VALIDITY_CHANGE, outcomeOf, retractionHook, unretractionHook, type ValidityOutcome,
} from "../memory/validity";

export type ForgetResult =
  | { status: "not_found" }
  | { status: "deleted"; vectorCount: number; trashed: boolean; edgesDropped: boolean; validity: ValidityOutcome };

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
  const now = Date.now();
  // D-RET: the rows this one closed reopen, in the same batch, before its edges and row are deleted.
  // The dependent cascade runs for a person's forget only; bulk integration removals apply the restore rule alone (P10).
  const hook = retractionHook(env, [{ id, workspaceId: row.workspace_id ?? "" }], () => "1", change, opts.config, now, { cascade: opts.reason === "forget" });
  const results = await env.DB.batch(trashManyStatements(env, plan, { reason: opts.reason, change, now, hook: hook.statements }));
  // A racing deleter removed it between the read and the batch: it owns the cleanup and the audit.
  if (changesOf(results[results.length - 1]) === 0) return { status: "not_found" };
  const done = hook.read(results, trashHookOffset(plan));
  await auditValidity(env, change, done);

  try {
    if (vectorIds.length) await deleteEntryVectors(env, [{ entryId: id, vectorIds }]);
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

  return { status: "deleted", vectorCount: vectorIds.length, trashed: plan.tier3.length === 0, edgesDropped: plan.tier2.length > 0, validity: outcomeOf(done) };
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
  return (await deprecateWithValidity(id, env, change, config, workspaceId, opts)).ok;
}

/** deprecateEntry, reporting what the retraction hook (D-RET) reopened. */
export async function deprecateWithValidity(
  id: string,
  env: Env,
  change: ChangeContext,
  config: Readonly<Config>,
  workspaceId: string,
  opts: { meta?: Record<string, unknown> } = {},
): Promise<{ ok: boolean; validity: ValidityOutcome }> {
  // A route's own scoped read can carry workspace_id as null/undefined for a legacy row; SQL NULL
  // never equals another NULL via `=`, so an un-normalized pin would fail this read and every
  // later write forever, even against the row's own real state. Coalesce to "" like every other
  // read of this column.
  const pinnedWorkspaceId = workspaceId ?? "";
  const row = await env.DB.prepare(
    `SELECT tags, vector_ids FROM entries WHERE id = ? AND workspace_id = ?`
  ).bind(id, pinnedWorkspaceId).first() as Record<string, any> | null;
  if (!row) return { ok: false, validity: NO_VALIDITY_CHANGE };

  const tags: string[] = JSON.parse(row.tags ?? "[]");
  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
  // validity: retraction-hooked
  const deprecatedTags = withStatus(tags, "deprecated");
  // vector_ids pinned too (round 6): the ids deleted below are exactly the ones this clear removed.
  const casColumns = { workspace_id: pinnedWorkspaceId, vector_ids: row.vector_ids ?? null };
  const now = Date.now();
  // D-RET: lands only once this row reads as deprecated, in the same batch.
  const hook = retractionHook(env, [{ id, workspaceId: pinnedWorkspaceId }], () => `x.tags LIKE '%"status:deprecated"%'`, change, config, now, { cascade: true });

  const results = await env.DB.batch([
    snapshotStatement(env, {
      entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags: deprecatedTags, meta: opts.meta, now,
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
    ...hook.statements,
  ]);
  if (changesOf(results[1]) === 0) return { ok: false, validity: NO_VALIDITY_CHANGE };
  const done = hook.read(results, 3);
  await auditValidity(env, change, done);

  try {
    if (vectorIds.length) await deleteEntryVectors(env, [{ entryId: id, vectorIds }]);
  } catch (e) {
    console.error("Vectorize deleteByIds failed during deprecate (non-fatal):", e);
  }
  return { ok: true, validity: outcomeOf(done) };
}

export type ApplyStatusResult =
  | { status: "ok"; indexed: boolean; validity: ValidityOutcome }
  | { status: "not_found" }
  /** A transient embed failure while leaving "deprecated": nothing below was written, the entry
   * is unchanged. Vectorize being unreachable is NOT this — that degrades to keyword-only instead
   * (indexed: false on the "ok" result), the same fallback restoreEntry uses (P8). */
  | { status: "reembed_failed" };

export async function applyStatus(id: string, status: MemoryStatus, env: Env, change: ChangeContext, config: Readonly<Config>, workspaceId: string): Promise<ApplyStatusResult> {
  if (status === "deprecated") {
    const r = await deprecateWithValidity(id, env, change, config, workspaceId, { meta: { status } });
    return r.ok ? { status: "ok", indexed: false, validity: r.validity } : { status: "not_found" };
  }
  // R2-3: pinned to the caller's authorized workspace, same reasoning as deprecateEntry above
  // (including its null/undefined normalization for a legacy row's column value).
  const pinnedWorkspaceId = workspaceId ?? "";
  const row = await env.DB.prepare(`SELECT content, tags, source, vector_ids FROM entries WHERE id = ? AND workspace_id = ?`).bind(id, pinnedWorkspaceId).first() as Record<string, any> | null;
  if (!row) return { status: "not_found" };
  const currentTags: string[] = JSON.parse(row.tags ?? "[]");
  const nextTags = withStatus(currentTags, status);
  // BE-9 (T-0101.8.2): deprecateEntry empties vector_ids on the way INTO "deprecated" (recall
  // must not find it), so leaving deprecated for any other status re-embeds before the status
  // commits, or the row would sit un-deprecated with a stale empty index. reembedOrDegrade is the
  // same fail-closed contract every other content writer uses: a transient failure throws (nothing
  // below runs, nothing is written); Vectorize being unreachable returns null and this degrades to
  // keyword-only, same as restoreEntry's own P8 fallback.
  let newVectorIdsJson: string | undefined;
  let indexed = (JSON.parse(row.vector_ids ?? "[]") as unknown[]).length > 0;
  const leavingDeprecated = getStatus(currentTags) === "deprecated";
  if (leavingDeprecated) {
    const writeCtx: WriteContext = { workspaceId: pinnedWorkspaceId, actorId: change.actorId || OWNER_WRITE_CONTEXT.actorId };
    let stored;
    try {
      stored = await reembedOrDegrade(env, id, row.content as string, nextTags, row.source as string, config, writeCtx);
    } catch (e) {
      console.error("Status re-embed failed while leaving deprecated (nothing written):", e);
      return { status: "reembed_failed" };
    }
    newVectorIdsJson = JSON.stringify(stored?.vectorIds ?? []);
    indexed = stored !== null;
  }

  // Replacing vector_ids pins the value read (round 6): the row decides which upload won.
  const casColumns = { workspace_id: pinnedWorkspaceId, ...(newVectorIdsJson !== undefined ? { vector_ids: row.vector_ids ?? null } : {}) };
  // A status set to what the row already has (tags may merely reorder) writes no version.
  const p = new Params();
  const tagsIdx = p.add(JSON.stringify(nextTags));
  const idIdx = p.add(id);
  const vectorIdsSet = newVectorIdsJson !== undefined ? `, vector_ids = ${p.add(newVectorIdsJson)}` : "";
  const now = Date.now();
  // D-RET undone: leaving deprecated closes again what this row's retraction reopened.
  const hook = leavingDeprecated
    ? unretractionHook(env, [{ id, workspaceId: pinnedWorkspaceId }], () => `x.tags NOT LIKE '%"status:deprecated"%'`, change, config, now, { cascade: true })
    : null;
  const results = await env.DB.batch([
    snapshotStatement(env, {
      entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags, meta: { status }, now,
      guard: p2 => buildCasGuard(p2, casColumns),
    }),
    // versioning: snapshot
    env.DB.prepare(`UPDATE entries AS e SET tags = ${tagsIdx}${vectorIdsSet} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values()),
    pruneStatement(env, id, config.VERSION_KEEP),
    ...(hook?.statements ?? []),
  ]);
  if (changesOf(results[1]) === 0) {
    // This call's own upload never became the row's: delete it (its ids are this upload's alone).
    if (newVectorIdsJson !== undefined) await discardUpload(env, id, JSON.parse(newVectorIdsJson) as string[]);
    return { status: "not_found" };
  }
  const done = hook ? [hook.read(results, 3)] : [];
  await auditValidity(env, change, ...done);
  return { status: "ok", indexed, validity: outcomeOf(...done) };
}
