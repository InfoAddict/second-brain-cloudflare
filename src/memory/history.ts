import type { Env } from "../env";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";

export interface TimelineEvent {
  event: string;
  created_at: number;
  actor_name: string;
  payload: Record<string, unknown>;
}

/** The event timeline used by entry detail and MCP history. The caller checks entry scope first. */
export async function readEntryTimeline(
  env: Env, id: string, viewerId: string, entryActorId = "", limit?: number,
): Promise<{ timeline: TimelineEvent[]; labelMap: Map<string, string> }> {
  const query = limit === undefined
    ? `SELECT actor_id, event, payload, created_at FROM entry_events WHERE entry_id = ? ORDER BY created_at ASC`
    : `SELECT actor_id, event, payload, created_at FROM entry_events WHERE entry_id = ? ORDER BY created_at DESC LIMIT ?`;
  const statement = env.DB.prepare(query);
  const { results } = await (limit === undefined ? statement.bind(id) : statement.bind(id, limit))
    .all<{ actor_id: string; event: string; payload: string; created_at: number }>();
  const rows = limit === undefined ? (results ?? []) : (results ?? []).reverse();
  const labelMap = await lookupActorLabels(env, [entryActorId, ...rows.map(e => e.actor_id)]);
  const timeline = rows.map(e => ({
    event: e.event,
    created_at: e.created_at,
    actor_name: resolveActorLabel(e.actor_id, labelMap, { viewerId }),
    payload: (() => { try { return JSON.parse(e.payload ?? "{}"); } catch { return {}; } })(),
  }));
  return { timeline, labelMap };
}
