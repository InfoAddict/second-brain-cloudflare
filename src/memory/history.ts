import type { Env } from "../env";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import type { Identity } from "../lib/identity";
import { getReadableEntry } from "../lib/entry-access";
import { scopeWhereForRead } from "../lib/scope";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { workspaceReadable } from "./versions";
import { visibleTimeline } from "./history-visibility";

export interface TimelineEvent {
  event: string;
  created_at: number;
  actor_name: string;
  payload: Record<string, unknown>;
}

/** The event timeline used by entry detail and MCP history. The caller checks entry scope first.
 * Reads one indexed statement; the shared-history cut (D-SH, A3) happens in JavaScript below. */
export async function readEntryTimeline(
  env: Env, id: string, identity: Identity, entryActorId = "", limit?: number, inlineLabels = false, entryWorkspaceId?: string,
): Promise<{ timeline: TimelineEvent[]; labelMap: Map<string, string> }> {
  // ev.rowid breaks a created_at tie by true insertion order (D1/SQLite serializes writes, so rowid
  // assignment IS the real happens-before order), not by whatever order a tied created_at otherwise
  // sorts in. Without it, a private event recorded in the same millisecond as the share event that
  // moved this row could sort as "newer" than the share and leak past the D-SH cut below.
  const query = inlineLabels
    ? `SELECT ev.actor_id, ev.event, ev.payload, ev.created_at, u.name AS user_name
       FROM entry_events ev LEFT JOIN users u ON u.id = ev.actor_id AND (u.removed_at IS NULL OR u.removed_at = 0)
       WHERE ev.entry_id = ? ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT ?`
    : limit === undefined
    ? `SELECT ev.actor_id, ev.event, ev.payload, ev.created_at FROM entry_events ev WHERE ev.entry_id = ? ORDER BY ev.created_at ASC, ev.rowid ASC`
    : `SELECT ev.actor_id, ev.event, ev.payload, ev.created_at FROM entry_events ev WHERE ev.entry_id = ? ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT ?`;
  const statement = env.DB.prepare(query);
  const { results } = await (limit === undefined && !inlineLabels ? statement.bind(id) : statement.bind(id, limit ?? 10))
    .all<{ actor_id: string; event: string; payload: string; created_at: number; user_name?: string | null }>();
  const rowsChrono = limit === undefined && !inlineLabels ? (results ?? []) : (results ?? []).reverse();
  const parsedChrono = rowsChrono.map(e => ({
    actor_id: e.actor_id,
    event: e.event,
    created_at: e.created_at,
    user_name: e.user_name,
    payload: (() => { try { return JSON.parse(e.payload ?? "{}"); } catch { return {}; } })() as Record<string, unknown>,
  }));

  // The author sees every event; anyone else sees events from the move that brought the memory
  // into a workspace they can read (D-SH, A3). A legacy row (actor_id "") has no author on file,
  // but its own owner still needs the full timeline of a memory sitting in their own personal
  // workspace — pre-4.0 move events recorded no fromWorkspaceId, so the D-SH walk below would
  // otherwise cut them off from their own history (ADV-11). This is narrowly the TENANT OWNER,
  // never any other admin: R2-4 found that matching "the row sits in identity's own personal
  // workspace" alone let an admin who unshared someone else's legacy row into their OWN personal
  // workspace inherit its private-era history too, since that check never asked whose tenant this
  // is. identity must BE the owner, and the row must sit in the owner's own personal workspace
  // (or, pre-workspace-migration, the legacy "" marker).
  const isLegacyOwnRow = entryActorId === "" && entryWorkspaceId !== undefined
    && identity.userId === (await ensureTenantBootstrap(env)).ownerUserId
    && (entryWorkspaceId === identity.personalWorkspaceId || entryWorkspaceId === "");
  const isAuthor = (entryActorId !== "" && identity.userId === entryActorId) || isLegacyOwnRow;
  let rows = parsedChrono;
  if (!isAuthor) {
    const newestFirst = [...parsedChrono].reverse();
    const needsOwner = newestFirst.some(e => e.payload.fromWorkspaceId === "");
    const ownerUserId = needsOwner ? (await ensureTenantBootstrap(env)).ownerUserId : undefined;
    rows = visibleTimeline(newestFirst, { canRead: ws => workspaceReadable(identity, ws, ownerUserId), isAuthor: false }).reverse();
  }

  const labelMap = inlineLabels
    ? new Map(rows.filter(e => e.actor_id && e.user_name).map(e => [e.actor_id, e.user_name!]))
    : await lookupActorLabels(env, [entryActorId, ...rows.map(e => e.actor_id)]);
  const timeline = rows.map(e => ({
    event: e.event,
    created_at: e.created_at,
    actor_name: resolveActorLabel(e.actor_id, labelMap, { viewerId: identity.userId }),
    payload: e.payload,
  }));
  return { timeline, labelMap };
}

/**
 * Scoped basic history: events (shared-history rule, D-SH/A3) and supersedes links.
 * A supersedes link is shown only when its other endpoint is readable too, the way
 * `connections` omits an unreadable neighbour.
 */
export async function readEntryHistory(env: Env, identity: Identity, id: string, limit = 10) {
  const entry = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id");
  if (!entry) return null;
  const edgeScope = scopeWhereForRead(identity, undefined, "e.workspace_id");
  const otherScope = scopeWhereForRead(identity, undefined, "o.workspace_id");
  const [timelineResult, edgeResult] = await Promise.all([
    readEntryTimeline(env, id, identity, String(entry.actor_id ?? ""), limit, true, String(entry.workspace_id ?? "")),
    env.DB.prepare(`SELECT e.source_id, e.target_id FROM edges e
      JOIN entries o ON o.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
      WHERE e.type = 'supersedes' AND (e.source_id = ? OR e.target_id = ?) AND ${edgeScope.clause} AND ${otherScope.clause}
      ORDER BY e.created_at DESC`)
      .bind(id, id, id, ...edgeScope.bindings, ...otherScope.bindings).all<{ source_id: string; target_id: string }>(),
  ]);
  return { timeline: timelineResult.timeline, edges: edgeResult.results };
}
