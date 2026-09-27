import type { Env } from "../env";
import { withStatus, type MemoryStatus } from "../memory/status";
import { deleteVectorIds } from "../vectorize/batch";

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
export async function deprecateEntry(id: string, env: Env, workspaceId?: string): Promise<boolean> {
  const pinned = workspaceId === undefined ? "" : " AND workspace_id = ?";
  const pin = workspaceId === undefined ? [] : [workspaceId];
  const row = await env.DB.prepare(
    // scope-exempt: by-id: routes gate with getReadableEntry before calling; captureEntry passes the writer's workspace
    `SELECT tags, vector_ids FROM entries WHERE id = ?${pinned}`
  ).bind(id, ...pin).first() as Record<string, any> | null;
  if (!row) return false;

  const tags: string[] = JSON.parse(row.tags ?? "[]");
  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

  const res = await env.DB.prepare(`UPDATE entries SET tags = ?, vector_ids = ? WHERE id = ?${pinned}`)
    .bind(JSON.stringify(withStatus(tags, "deprecated")), "[]", id, ...pin).run();
  if (workspaceId !== undefined && (res.meta?.changes ?? res.meta?.rows_written ?? 1) === 0) return false;

  try {
    if (vectorIds.length) await deleteVectorIds(env, vectorIds);
  } catch (e) {
    console.error("Vectorize deleteByIds failed during deprecate (non-fatal):", e);
  }
  return true;
}

export async function applyStatus(id: string, status: MemoryStatus, env: Env): Promise<boolean> {
  if (status === "deprecated") return deprecateEntry(id, env);
  // scope-exempt: by-id: routes gate with getReadableEntry before calling
  const row = await env.DB.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(id).first() as Record<string, any> | null;
  if (!row) return false;
  const tags: string[] = JSON.parse(row.tags ?? "[]");
  await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(withStatus(tags, status)), id).run();
  return true;
}
