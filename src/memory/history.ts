import type { Env } from "../env";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import type { Identity } from "../lib/identity";
import { getReadableEntry } from "../lib/entry-access";
import { scopeWhereForRead } from "../lib/scope";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { resolveConfig } from "../config";
import { loadHistory, workspaceReadable } from "./versions";
import { visibleTimeline } from "./history-visibility";
import { buildEntryHistoryFromReads } from "./history-view";

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
  /** BE-7 (T-0101.1.1): extra actor ids to resolve in the SAME `users` read as the events'
   * own actors — buildEntryHistory's version actors, so a caller merging events and versions
   * into one view never pays a second label statement for the versions' own names. Ignored when
   * `inlineLabels` is true: that path resolves labels via a JOIN keyed to entry_events rows, which
   * has no room for an actor id that never wrote an event on this entry. */
  extraLabelActorIds: string[] = [],
): Promise<{ timeline: TimelineEvent[]; labelMap: Map<string, string>; cut: boolean }> {
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
  // into a workspace they can read (D-SH, A3). A legacy row (actor_id "") has no author on file at
  // all — not even the tenant owner, since digests and auto-insights are ALSO written with an
  // empty actor (isSystemRow), in whichever member's workspace they summarize. R2-4 found that
  // granting the owner a blanket bypass for "the row sits in the owner's own personal workspace"
  // let an admin who unshared someone ELSE's legacy row into their own personal workspace inherit
  // its private-era history too. R3-4 found the narrower R2-4 fix was still too wide: the owner's
  // OWN digest, shared and then unshared back into the owner's personal workspace, satisfied the
  // same "sits in the owner's own workspace" test and exposed the summarized member's private-era
  // events. There is no version of this check keyed on where the row currently sits that is safe —
  // isAuthor is never true for a legacy row. What the owner DOES get, via
  // treatAbsentFromAsReadable below: a move event that predates the fromWorkspaceId field entirely
  // (truly pre-4.0, when there was only one user to have written anything before it) lets the walk
  // continue past it instead of cutting there (ADV-11) — never a move event that actually records
  // a fromWorkspaceId, even the pre-tenancy "" marker, which goes through the ordinary cut.
  const isAuthor = entryActorId !== "" && identity.userId === entryActorId;
  let rows = parsedChrono;
  let cut = false;
  if (!isAuthor) {
    const newestFirst = [...parsedChrono].reverse();
    const needsOwner = entryActorId === "" || newestFirst.some(e => e.payload.fromWorkspaceId === "");
    const ownerUserId = needsOwner ? (await ensureTenantBootstrap(env)).ownerUserId : undefined;
    const isOwnerOfLegacyRow = entryActorId === "" && ownerUserId !== undefined && identity.userId === ownerUserId;
    const visible = visibleTimeline(newestFirst, {
      canRead: ws => workspaceReadable(identity, ws, ownerUserId), isAuthor: false,
      treatAbsentFromAsReadable: isOwnerOfLegacyRow,
    });
    rows = [...visible.items].reverse();
    cut = visible.cut;
  }

  const labelMap = inlineLabels
    ? new Map(rows.filter(e => e.actor_id && e.user_name).map(e => [e.actor_id, e.user_name!]))
    : await lookupActorLabels(env, [entryActorId, ...rows.map(e => e.actor_id), ...extraLabelActorIds]);
  const timeline = rows.map(e => ({
    event: e.event,
    created_at: e.created_at,
    actor_name: resolveActorLabel(e.actor_id, labelMap, { viewerId: identity.userId }),
    payload: e.payload,
  }));
  return { timeline, labelMap, cut };
}

/**
 * Scoped basic history for chat's `history` tool (BE-11, T-0101.3.1): contract 4.1's merged
 * changes-and-events (buildEntryHistoryFromReads) plus supersedes links. A supersedes link is
 * shown only when its other endpoint is readable too, the way `connections` omits an unreadable
 * neighbour.
 *
 * One entry_events read, like `/entry`'s own wiring: readEntryTimeline runs once, unbounded, with
 * the versions' own actor ids folded in as extraLabelActorIds, so the one users read it already
 * makes covers version actors too.
 */
export async function readEntryHistory(env: Env, identity: Identity, id: string) {
  const entry = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, content, created_at");
  if (!entry) return null;
  const edgeScope = scopeWhereForRead(identity, undefined, "e.workspace_id");
  const otherScope = scopeWhereForRead(identity, undefined, "o.workspace_id");
  const rawEntry = entry as unknown as Record<string, unknown>;
  const historyRow = {
    id: entry.id, workspace_id: String(entry.workspace_id ?? ""), actor_id: String(entry.actor_id ?? ""),
    content: String(entry.content ?? ""), created_at: Number(rawEntry.created_at ?? 0),
  };
  const config = await resolveConfig(env);
  const chain = await loadHistory(env, identity, { id: historyRow.id, content: historyRow.content }, config.VERSION_KEEP);
  const [timelineResult, edgeResult] = await Promise.all([
    readEntryTimeline(env, id, identity, historyRow.actor_id, undefined, false, historyRow.workspace_id, chain.rows.map(r => r.actor_id)),
    env.DB.prepare(`SELECT e.source_id, e.target_id FROM edges e
      JOIN entries o ON o.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
      WHERE e.type = 'supersedes' AND (e.source_id = ? OR e.target_id = ?) AND ${edgeScope.clause} AND ${otherScope.clause}
      ORDER BY e.created_at DESC`)
      .bind(id, id, id, ...edgeScope.bindings, ...otherScope.bindings).all<{ source_id: string; target_id: string }>(),
  ]);
  const history = await buildEntryHistoryFromReads(env, identity, historyRow, config, chain, timelineResult);
  return { history, edges: edgeResult.results };
}
