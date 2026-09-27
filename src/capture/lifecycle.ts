import type { Env } from "../env";
import { withStatus, type MemoryStatus } from "../memory/status";
import { deleteVectorIds } from "../vectorize/batch";
import type { Config } from "../config";
import type { ChangeContext } from "../lib/audit";
import { changesOf, pruneStatement, snapshotStatement } from "../memory/versions";

export type ForgetResult =
  | { status: "not_found" }
  | { status: "deleted"; vectorCount: number };

export async function forgetEntry(id: string, env: Env): Promise<ForgetResult> {
  const row = await env.DB.prepare(
    // scope-exempt: by-id: routes gate with getReadableEntry before calling
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  if (!row) return { status: "not_found" };

  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

  // versioning: hard-delete: forget; moves to entries_trash in Task 7 (T-0089.1.2, builder B) — a hard delete until then
  // scope-exempt: by-id delete: routes gate with getReadableEntry before calling
  const deletion = await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id).run();
  // A racing deleter removed it between the read and here: it owns the cleanup and the audit.
  if (deletion?.meta?.changes === 0) return { status: "not_found" };

  try {
    // scope-exempt: by-id cascade: edge endpoints of the row just deleted
    await env.DB.prepare(`DELETE FROM edges WHERE source_id = ? OR target_id = ?`).bind(id, id).run();
  } catch (e) {
    console.error("Edge cascade-delete failed (non-fatal):", e);
  }

  try {
    if (vectorIds.length) {
      await deleteVectorIds(env, vectorIds);
    }
  } catch (e) {
    console.error("Vectorize delete failed (non-fatal):", e);
  }

  return { status: "deleted", vectorCount: vectorIds.length };
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
 * `workspaceId`, when given, pins both the read and the write to that workspace: a row that has
 * moved since the caller's scoped read is left alone and false is returned. Routes gate with
 * getReadableEntry and omit it.
 */
export async function deprecateEntry(
  id: string,
  env: Env,
  change: ChangeContext,
  config: Readonly<Config>,
  opts: { workspaceId?: string; meta?: Record<string, unknown> } = {},
): Promise<boolean> {
  const { workspaceId } = opts;
  const pinned = workspaceId === undefined ? "" : " AND workspace_id = ?";
  const pin = workspaceId === undefined ? [] : [workspaceId];
  const row = await env.DB.prepare(
    // scope-exempt: by-id: routes gate with getReadableEntry before calling; captureEntry passes the writer's workspace
    `SELECT tags, vector_ids FROM entries WHERE id = ?${pinned}`
  ).bind(id, ...pin).first() as Record<string, any> | null;
  if (!row) return false;

  const tags: string[] = JSON.parse(row.tags ?? "[]");
  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
  const deprecatedTags = withStatus(tags, "deprecated");

  const results = await env.DB.batch([
    snapshotStatement(env, {
      entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags: deprecatedTags, meta: opts.meta, now: Date.now(),
      // The UPDATE below is pinned to the writer's workspace; so is its snapshot.
      guard: workspaceId === undefined ? undefined : p => `e.workspace_id = ${p.add(workspaceId)}`,
    }),
    // versioning: snapshot
    env.DB.prepare(`UPDATE entries SET tags = ?, vector_ids = ? WHERE id = ?${pinned}`)
      .bind(JSON.stringify(deprecatedTags), "[]", id, ...pin),
    pruneStatement(env, id, config.VERSION_KEEP),
  ]);
  if (workspaceId !== undefined && changesOf(results[1]) === 0) return false;

  try {
    if (vectorIds.length) await deleteVectorIds(env, vectorIds);
  } catch (e) {
    console.error("Vectorize deleteByIds failed during deprecate (non-fatal):", e);
  }
  return true;
}

export async function applyStatus(id: string, status: MemoryStatus, env: Env, change: ChangeContext, config: Readonly<Config>): Promise<boolean> {
  if (status === "deprecated") return deprecateEntry(id, env, change, config, { meta: { status } });
  // scope-exempt: by-id: routes gate with getReadableEntry before calling
  const row = await env.DB.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(id).first() as Record<string, any> | null;
  if (!row) return false;
  const nextTags = withStatus(JSON.parse(row.tags ?? "[]") as string[], status);
  // A status set to what the row already has (tags may merely reorder) writes no version.
  await env.DB.batch([
    snapshotStatement(env, { entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags, meta: { status }, now: Date.now() }),
    // versioning: snapshot
    env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(nextTags), id),
    pruneStatement(env, id, config.VERSION_KEEP),
  ]);
  return true;
}
