import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { isCompanyWorkspace, scopeWhere, scopeWrite } from "../lib/scope";
import { VECTORIZE_GET_BY_IDS_BATCH } from "../constants";
import type { ChangeContext } from "../lib/audit";
import { changesOf } from "../memory/versions";

/** Move entries between personal and company workspaces; sharing is not a copy. */

export type ShareTarget = "personal" | "company";

export type ShareResult =
  | { status: "shared"; workspaceId: string; vectorIds: string[]; fromWorkspaceId: string }
  | { status: "unshared"; workspaceId: string; vectorIds: string[]; fromWorkspaceId: string }
  | { status: "no_change"; workspaceId: string; vectorIds: string[] }
  | { status: "not_found" }
  /** R3-2/T-0089.7.4: the row is still there, but it moved (or was forgotten and re-captured)
   * since this call's own read — the caller's authorization no longer describes it. A conflict
   * to retry, not the false success the unpinned UPDATE used to report. */
  | { status: "conflict" }
  | { status: "forbidden" };

export async function moveEntry(
  id: string,
  target: ShareTarget,
  env: Env,
  identity: Identity,
  change: ChangeContext,
  team?: string,
): Promise<ShareResult> {
  const scope = scopeWhere(identity);
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, actor_id, vector_ids FROM entries WHERE id = ? AND ${scope.clause}`
  ).bind(id, ...scope.bindings).first<{ id: string; workspace_id: string; actor_id: string; vector_ids: string }>();
  if (!row) return { status: "not_found" };

  // Parse before moving the row so malformed metadata cannot fail after commit.
  let vectorIds: string[] = [];
  try { vectorIds = JSON.parse(row.vector_ids ?? "[]") as string[]; } catch { vectorIds = []; }

  // Admins un-share another person's entry into their own personal workspace.
  const targetWorkspaceId = scopeWrite(identity, target, target === "company" ? team : undefined);
  // Carries vectorIds/workspaceId like the moved branches do, so a caller can
  // repair a stale Vectorize stamp on an already-moved row by re-running.
  if (row.workspace_id === targetWorkspaceId) return { status: "no_change", workspaceId: targetWorkspaceId, vectorIds };

  if (isCompanyWorkspace(identity, row.workspace_id) && target === "personal") {
    const isActor = row.actor_id === identity.userId;
    if (!isActor && identity.role !== "admin") return { status: "forbidden" };
  }

  // The move event is written first, inside this same batch, reading the row's workspace as it
  // stands in this transaction (M5, L2) — never the JavaScript read above, which a concurrent
  // move could have already overtaken. A move to the current workspace (raced there first)
  // writes no event. This is a deliberate exception to the fire-and-forget audit contract: the
  // event is load-bearing for shared-history visibility, so it commits or fails with the move.
  //
  // R3-2/T-0089.7.4: the entries and edges UPDATEs are now pinned to the workspace this call's own
  // read found (row.workspace_id) — an unpinned UPDATE used to move whatever workspace the row
  // happened to be in BY THE TIME THE BATCH RAN, not the one this caller was authorized against.
  // An admin's unshare of a company row could therefore take a member's memory that the member
  // had already made private again in the gap between the read and the batch, and a concurrent
  // forget of the row (or its re-capture under the same id) was reported as a successful move.
  // R4-C1: the event insert's guard must be the SAME pin as the UPDATE below it (e.workspace_id =
  // row.workspace_id), not `<> target`. Those two conditions only agree when the row can only have
  // moved TO the target since the read; if it moved to a THIRD workspace in the gap, the pinned
  // UPDATE correctly misses while `<> target` is still true, so the event fired for a move that
  // never happened. Sharing the exact pin makes all three statements hit or miss together.
  const event = target === "company" ? "shared" : "unshared";
  const results = await env.DB.batch([
    // scope-exempt: by-id: the row was read above under the caller's own scope
    env.DB.prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
       SELECT ?, e.id, ?, ?, json_object('workspaceId', ?, 'fromWorkspaceId', e.workspace_id, 'channel', ?), ?
         FROM entries e WHERE e.id = ? AND e.workspace_id = ?`
    ).bind(crypto.randomUUID(), change.actorId, event, targetWorkspaceId, change.channel, Date.now(), id, row.workspace_id),
    // versioning: exempt: a move changes location, not content, tags or when_*
    env.DB.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ? AND workspace_id = ?`)
      .bind(targetWorkspaceId, id, row.workspace_id),
    // Edges carry denormalized workspace metadata and must move with the entry, and only that
    // entry's own edges as of this same read — pinned the same way as the row itself.
    env.DB.prepare(`UPDATE edges SET workspace_id = ? WHERE (source_id = ? OR target_id = ?) AND workspace_id = ?`)
      .bind(targetWorkspaceId, id, id, row.workspace_id),
  ]);

  if (changesOf(results[1]) === 0) {
    // The row moved, or was forgotten and possibly re-captured under the same id, since this
    // call's own read: nothing above committed. Distinguish gone from moved (R2-5's same
    // reasoning) rather than reporting either as the success the unpinned UPDATE used to.
    // R4-C2: re-read workspace_id (not just liveness) — a concurrent caller may have already
    // landed the row exactly where THIS caller asked (two tabs sharing the same memory). That is
    // success, not a conflict to retry, so it gets the same no_change shape the early-return
    // above uses, vector_ids parsed the same defensive way.
    // scope-exempt: by-id: liveness re-read for a row this call already read under its own scope
    const stillThere = await env.DB.prepare(`SELECT workspace_id, vector_ids FROM entries WHERE id = ?`)
      .bind(id).first<{ workspace_id: string; vector_ids: string }>();
    if (!stillThere) return { status: "not_found" };
    if (stillThere.workspace_id === targetWorkspaceId) {
      let sameVectorIds: string[] = [];
      try { sameVectorIds = JSON.parse(stillThere.vector_ids ?? "[]") as string[]; } catch { sameVectorIds = []; }
      return { status: "no_change", workspaceId: targetWorkspaceId, vectorIds: sameVectorIds };
    }
    return { status: "conflict" };
  }

  return { status: event, workspaceId: targetWorkspaceId, vectorIds, fromWorkspaceId: row.workspace_id };
}

/**
 * Best-effort metadata update; SQL remains the correctness boundary.
 * Never throws (per-chunk catch, not one catch around the whole loop, so one
 * bad chunk doesn't abort the rest) — /share's ctx.waitUntil path depends on
 * that. Returns whether every requested id was verifiably re-stamped (an id
 * the index no longer returns counts as a failure), for callers (the
 * #347 move route) that need to know rather than just fire-and-forget.
 */
export async function restampVectorWorkspace(env: Env, vectorIds: string[], workspaceId: string): Promise<{ ok: boolean }> {
  let ok = true;
  for (let i = 0; i < vectorIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
    const batch = vectorIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH);
    if (!batch.length) continue;
    try {
      const vectors = await env.VECTORIZE.getByIds(batch);
      // Ids the index does not return CANNOT have been re-stamped; reporting
      // them ok let a move claim "searchable in the new layer" for an entry
      // nothing in the index points at (#355). Missing is a failure, not a skip.
      if (vectors.length < batch.length) ok = false;
      if (!vectors.length) continue;
      await env.VECTORIZE.upsert(
        vectors.map(v => ({ ...v, metadata: { ...v.metadata, workspace_id: workspaceId } })),
      );
    } catch (e) {
      console.error("Vectorize workspace re-stamp failed (non-fatal):", e);
      ok = false;
    }
  }
  return { ok };
}
