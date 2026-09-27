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
  env: Env, id: string, viewerId: string, entryActorId = "", limit?: number, inlineLabels = false,
): Promise<{ timeline: TimelineEvent[]; labelMap: Map<string, string> }> {
  const query = inlineLabels
    ? `SELECT ev.actor_id, ev.event, ev.payload, ev.created_at, u.name AS user_name
       FROM entry_events ev LEFT JOIN users u ON u.id = ev.actor_id AND (u.removed_at IS NULL OR u.removed_at = 0)
       WHERE ev.entry_id = ? ORDER BY ev.created_at DESC LIMIT ?`
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

/** Scoped basic history, before version snapshots arrive in a later wave. */
export async function readEntryHistory(env: Env, identity: Identity, id: string, limit = 10) {
  const entry = await getReadableEntry(env, identity, id);
  if (!entry) return null;
  const scope = scopeWhereForRead(identity);
  const [timelineResult, edgeResult] = await Promise.all([
    readEntryTimeline(env, id, identity.userId, "", limit, true),
    env.DB.prepare(`SELECT source_id, target_id FROM edges
      WHERE type = 'supersedes' AND (source_id = ? OR target_id = ?) AND ${scope.clause}
      ORDER BY created_at DESC`)
      .bind(id, id, ...scope.bindings).all<{ source_id: string; target_id: string }>(),
  ]);
  return { timeline: timelineResult.timeline, edges: edgeResult.results };
}
