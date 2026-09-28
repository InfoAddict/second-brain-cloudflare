const MOVE_EVENTS = new Set(["shared", "unshared"]);

export interface VisibleEvent {
  event: string;
  payload?: Record<string, unknown> | null;
}

/**
 * Which events of a memory's timeline a reader may see (D-SH). The author sees everything. Anyone else
 * sees events back to the move that brought the memory into a workspace they can read: walking newest
 * first, the cut falls at the first `shared`/`unshared` event whose source is unreadable, or cannot be
 * determined at all. That event is included, since it marks the arrival.
 *
 * A move event written before 4.0 carries no `fromWorkspaceId` at all. When an OLDER move exists,
 * its own destination (`workspaceId`) tells us where this one's source must have been — the row
 * cannot have moved again between that landing and this one without ANOTHER recorded move — so we
 * infer it and check ITS readability, for every reader, not just the owner.
 *
 * `treatAbsentFromAsReadable` (R3-4, narrowed by R4-L1): when there is no older move to infer a
 * source from at all, the source predates every recorded move — genuinely pre-tenancy, back when
 * there was only one user. That is the ONE case this flag may still widen, and the caller (history.ts)
 * must never set it for a system row (a digest or auto-insight): those are written into the
 * summarized MEMBER's workspace with an empty actor, and 3.7 was already multi-user, so "no earlier
 * move" there means "someone else's private era", not "before multi-user existed". A move event that
 * DOES carry a fromWorkspaceId, even the pre-tenancy "" marker, or that resolves via inference, goes
 * through the ordinary `canRead` cut — this flag never widens either of those.
 */
/**
 * `cut` (T-0101.1.1, BE-7's `footer.shared_cut_by`): whether this walk actually stopped early —
 * false for the author (never cut) and false for a non-author whose walk reached the start of the
 * array with nothing unreadable in the way. The dashboard and MCP history need this to decide
 * whose name to show in "Earlier history belongs to {name}" — a decision `visibleTimeline` itself
 * has no business making (it doesn't know who the author is), so it reports the fact and leaves
 * naming to the caller.
 */
export function visibleTimeline<E extends VisibleEvent>(
  eventsNewestFirst: E[],
  opts: { canRead: (workspaceId: string) => boolean; isAuthor: boolean; treatAbsentFromAsReadable?: boolean },
): { items: E[]; cut: boolean } {
  if (opts.isAuthor) return { items: eventsNewestFirst, cut: false };
  const out: E[] = [];
  let cut = false;
  for (let i = 0; i < eventsNewestFirst.length; i++) {
    const e = eventsNewestFirst[i];
    out.push(e);
    if (!MOVE_EVENTS.has(e.event)) continue;
    const from = e.payload?.fromWorkspaceId;
    if (typeof from === "string") {
      if (!opts.canRead(from)) { cut = true; break; }
      continue;
    }
    const olderMove = eventsNewestFirst.slice(i + 1).find(x => MOVE_EVENTS.has(x.event));
    const dest = olderMove?.payload?.workspaceId;
    if (typeof dest === "string") {
      if (!opts.canRead(dest)) { cut = true; break; }
      continue;
    }
    // No earlier move to infer from at all: the one narrow, caller-gated exception.
    if (opts.treatAbsentFromAsReadable) continue;
    cut = true; break;
  }
  return { items: out, cut };
}
