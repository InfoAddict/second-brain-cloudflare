import type { Env } from "../env";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import type { Identity } from "../lib/identity";
import { getReadableEntry } from "../lib/entry-access";
import { scopeWhereForRead } from "../lib/scope";

export interface TimelineEvent {
  event: string;
  created_at: number;
  actor_name: string;
  payload: Record<string, unknown>;
}

/** The event timeline used by entry detail and MCP history. The caller checks entry scope first. */
export async function readEntryTimeline(
  env: Env, id: string, viewerId: string, entryActorId = "", limit?: number, inlineLabels = false, sinceShared = false,
): Promise<{ timeline: TimelineEvent[]; labelMap: Map<string, string> }> {
  const query = inlineLabels
    ? `SELECT ev.actor_id, ev.event, ev.payload, ev.created_at, u.name AS user_name
       FROM entry_events ev LEFT JOIN users u ON u.id = ev.actor_id AND (u.removed_at IS NULL OR u.removed_at = 0)
       WHERE ev.entry_id = ?${sinceShared
         ? ` AND ev.created_at >= COALESCE((SELECT MAX(sh.created_at) FROM entry_events sh WHERE sh.entry_id = ev.entry_id AND sh.event = 'shared'), 0)`
         : ""}
       ORDER BY ev.created_at DESC LIMIT ?`
    : limit === undefined
    ? `SELECT actor_id, event, payload, created_at FROM entry_events WHERE entry_id = ? ORDER BY created_at ASC`
    : `SELECT actor_id, event, payload, created_at FROM entry_events WHERE entry_id = ? ORDER BY created_at DESC LIMIT ?`;
  const statement = env.DB.prepare(query);
  const { results } = await (limit === undefined && !inlineLabels ? statement.bind(id) : statement.bind(id, limit ?? 10))
    .all<{ actor_id: string; event: string; payload: string; created_at: number; user_name?: string | null }>();
  const rows = limit === undefined && !inlineLabels ? (results ?? []) : (results ?? []).reverse();
  const labelMap = inlineLabels
    ? new Map(rows.filter(e => e.actor_id && e.user_name).map(e => [e.actor_id, e.user_name!]))
    : await lookupActorLabels(env, [entryActorId, ...rows.map(e => e.actor_id)]);
  const timeline = rows.map(e => ({
    event: e.event,
    created_at: e.created_at,
    actor_name: resolveActorLabel(e.actor_id, labelMap, { viewerId }),
    payload: (() => { try { return JSON.parse(e.payload ?? "{}"); } catch { return {}; } })(),
  }));
  return { timeline, labelMap };
}

/**
 * Scoped basic history, before version snapshots arrive in a later wave.
 *
 * A reader who is not the author sees events only from the latest `shared` event on: what
 * happened while the memory was still private is not theirs. A supersedes link is shown only
 * when its other endpoint is readable too, the way `connections` omits an unreadable neighbour.
 */
export async function readEntryHistory(env: Env, identity: Identity, id: string, limit = 10) {
  const entry = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id");
  if (!entry) return null;
  const ownHistory = entry.actor_id === identity.userId || entry.workspace_id === identity.personalWorkspaceId;
  const edgeScope = scopeWhereForRead(identity, undefined, "e.workspace_id");
  const otherScope = scopeWhereForRead(identity, undefined, "o.workspace_id");
  const [timelineResult, edgeResult] = await Promise.all([
    readEntryTimeline(env, id, identity.userId, "", limit, true, !ownHistory),
    env.DB.prepare(`SELECT e.source_id, e.target_id FROM edges e
      JOIN entries o ON o.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
      WHERE e.type = 'supersedes' AND (e.source_id = ? OR e.target_id = ?) AND ${edgeScope.clause} AND ${otherScope.clause}
      ORDER BY e.created_at DESC`)
      .bind(id, id, id, ...edgeScope.bindings, ...otherScope.bindings).all<{ source_id: string; target_id: string }>(),
  ]);
  return { timeline: timelineResult.timeline, edges: edgeResult.results };
}
