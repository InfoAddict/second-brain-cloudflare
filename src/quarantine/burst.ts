// The scorer's one new D1 read (16-t3-t4-trust-spec.md 5.2, B1): MCP content writes by the
// acting actor in the last 10 minutes, not counting the write being scored (that write has not
// been audited yet, so it can never see itself here). Runs only for MCP remember, update and
// append; REST and system writes never call this.
import type { Env } from "../env";

export const QUARANTINE_BURST_WINDOW_MS = 10 * 60 * 1000;

/**
 * Bounded by the 10-minute range and `limit` (QUARANTINE_WRITE_BURST): rows read cannot exceed
 * `limit` whatever the actual burst size is.
 */
export async function countMcpWritesInWindow(env: Env, actorId: string, now: number, limit: number): Promise<number> {
  const row = await env.DB.prepare(
    // scope-exempt: by-id: entry_events carries no workspace column; this counts one actor's own recent writes, a heuristic input, not a scoped read
    `SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM entry_events INDEXED BY idx_entry_events_created
      WHERE created_at > ?1 AND actor_id = ?2
        AND event IN ('created','updated','appended')
        AND json_extract(payload, '$.channel') = 'mcp'
      LIMIT ?3)`,
  ).bind(now - QUARANTINE_BURST_WINDOW_MS, actorId, limit).first<{ n: number }>();
  return row?.n ?? 0;
}
