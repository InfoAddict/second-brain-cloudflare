const MOVE_EVENTS = new Set(["shared", "unshared"]);

export interface VisibleEvent {
  event: string;
  payload?: Record<string, unknown> | null;
}

/**
 * Which events of a memory's timeline a reader may see (D-SH). The author sees everything. Anyone else
 * sees events back to the move that brought the memory into a workspace they can read: walking newest
 * first, the cut falls at the first `shared`/`unshared` event whose `fromWorkspaceId` is absent
 * (written before 4.0) or unreadable. That event is included, since it marks the arrival.
 */
export function visibleTimeline<E extends VisibleEvent>(
  eventsNewestFirst: E[],
  opts: { canRead: (workspaceId: string) => boolean; isAuthor: boolean },
): E[] {
  if (opts.isAuthor) return eventsNewestFirst;
  const out: E[] = [];
  for (const e of eventsNewestFirst) {
    out.push(e);
    if (!MOVE_EVENTS.has(e.event)) continue;
    const from = e.payload?.fromWorkspaceId;
    if (typeof from !== "string" || !opts.canRead(from)) break;
  }
  return out;
}
