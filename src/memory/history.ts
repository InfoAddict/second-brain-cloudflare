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
  /** R4-L1: the row's own `source`. A digest or auto-insight (isSystemRow, capture/entry.ts)
   * carries an empty actor too, but summarizes a SPECIFIC member into THEIR workspace — the
   * legacy-owner exception below must never widen for one, no matter who currently reads it. */
  entrySource = "",
): Promise<{ timeline: TimelineEvent[]; labelMap: Map<string, string>; cut: boolean }> {
  // ev.rowid breaks a created_at tie by true insertion order (D1/SQLite serializes writes, so rowid
  // assignment IS the real happens-before order), not by whatever order a tied created_at otherwise
  // sorts in. Without it, a private event recorded in the same millisecond as the share event that
  // moved this row could sort as "newer" than the share and leak past the D-SH cut below.
  //
  // Round 3 re-review MAJOR: a reused id's earlier life always ends with a `purged` event (the
  // trash retention sweep, or an explicit delete forever — both write that same event name) or a
  // `deleted` event with payload.trash false (tier 3, too large for the trash to ever hold): every
  // other event below the LATEST such end event for this id belongs to whoever's row is now gone,
  // never this row's own history. `LIFE_START` is that end event's own rowid (0 when there has
  // never been one) — insertion order again, not created_at: an old export's own created_at, or
  // one a legacy client set in the future, said nothing true about when THIS Worker actually wrote
  // either event, so comparing them was never sound (T-0102, director follow-up, this round
  // supersedes the entryCreatedAt floor it replaces — no caller needs its own row read for this
  // anymore, and no schema change: rowid is every SQLite table's own, always).
  const LIFE_START = `COALESCE((SELECT MAX(g.rowid) FROM entry_events g WHERE g.entry_id = ev.entry_id
       AND (g.event = 'purged' OR (g.event = 'deleted' AND json_extract(g.payload, '$.trash') = 0))), 0)`;
  const query = inlineLabels
    ? `SELECT ev.actor_id, ev.event, ev.payload, ev.created_at, u.name AS user_name
       FROM entry_events ev LEFT JOIN users u ON u.id = ev.actor_id AND (u.removed_at IS NULL OR u.removed_at = 0)
       WHERE ev.entry_id = ? AND ev.rowid > ${LIFE_START} ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT ?`
    : limit === undefined
    ? `SELECT ev.actor_id, ev.event, ev.payload, ev.created_at FROM entry_events ev WHERE ev.entry_id = ? AND ev.rowid > ${LIFE_START} ORDER BY ev.created_at ASC, ev.rowid ASC`
    : `SELECT ev.actor_id, ev.event, ev.payload, ev.created_at FROM entry_events ev WHERE ev.entry_id = ? AND ev.rowid > ${LIFE_START} ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT ?`;
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
  // its private-era history too. R3-4's narrower fix (the owner reading a legacy row with no
  // fromWorkspaceId on its move continues past it, isOwnerOfLegacyRow below) was STILL too wide:
  // R4-L1 found 3.7 was already multi-user, and a digest/insight (isSystemRow) with an empty actor
  // summarizes a SPECIFIC member into THEIR OWN workspace — "no earlier move to infer a source
  // from" there means "someone else's private era", never "before multi-user existed". isAuthor is
  // never true for a legacy row, so isOwnerOfLegacyRow now ALSO requires the row not be a system
  // row, and visibleTimeline tries inferring a missing source from the chain of earlier moves
  // first, falling back to this flag only when there is no earlier move to infer from at all.
  const isAuthor = entryActorId !== "" && identity.userId === entryActorId;
  let rows = parsedChrono;
  let cut = false;
  if (!isAuthor) {
    const newestFirst = [...parsedChrono].reverse();
    const needsOwner = entryActorId === "" || newestFirst.some(e => e.payload.fromWorkspaceId === "");
    const ownerUserId = needsOwner ? (await ensureTenantBootstrap(env)).ownerUserId : undefined;
    const isOwnerOfLegacyRow = entryActorId === "" && entrySource !== "system" && ownerUserId !== undefined && identity.userId === ownerUserId;
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
  const entry = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, content, created_at, source, valid_until");
  if (!entry) return null;
  const edgeScope = scopeWhereForRead(identity, undefined, "e.workspace_id");
  const otherScope = scopeWhereForRead(identity, undefined, "o.workspace_id");
  const rawEntry = entry as unknown as Record<string, unknown>;
  const historyRow = {
    id: entry.id, workspace_id: String(entry.workspace_id ?? ""), actor_id: String(entry.actor_id ?? ""),
    content: String(entry.content ?? ""), created_at: Number(rawEntry.created_at ?? 0),
    valid_until: rawEntry.valid_until == null ? null : Number(rawEntry.valid_until),
  };
  const config = await resolveConfig(env);
  const chain = await loadHistory(env, identity, { id: historyRow.id, content: historyRow.content }, config.VERSION_KEEP);
  const [timelineResult, edgeResult] = await Promise.all([
    readEntryTimeline(env, id, identity, historyRow.actor_id, undefined, false, historyRow.workspace_id, chain.rows.map(r => r.actor_id), String(rawEntry.source ?? "")),
    env.DB.prepare(`SELECT e.source_id, e.target_id FROM edges e
      JOIN entries o ON o.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
      WHERE e.type = 'supersedes' AND (e.source_id = ? OR e.target_id = ?) AND ${edgeScope.clause} AND ${otherScope.clause}
      ORDER BY e.created_at DESC`)
      .bind(id, id, id, ...edgeScope.bindings, ...otherScope.bindings).all<{ source_id: string; target_id: string }>(),
  ]);
  const history = await buildEntryHistoryFromReads(env, identity, historyRow, config, chain, timelineResult);
  return { history, edges: edgeResult.results };
}
