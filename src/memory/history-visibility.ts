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
 *
 * `treatAbsentFromAsReadable` (R3-4): the tenant owner reading a legacy row (empty actor) gets ONE
 * narrow exception to that cut, not a blanket bypass — an absent `fromWorkspaceId` means the move
 * predates the field entirely, back when there was only one user (the owner) to have written
 * anything before it, so the walk continues past it instead of stopping. A move event that DOES
 * carry a `fromWorkspaceId`, even the pre-tenancy "" marker, goes through the ordinary
 * `canRead`/unreadable cut like anyone else's — this flag never widens that check.
 */
export function visibleTimeline<E extends VisibleEvent>(
  eventsNewestFirst: E[],
  opts: { canRead: (workspaceId: string) => boolean; isAuthor: boolean; treatAbsentFromAsReadable?: boolean },
): E[] {
  if (opts.isAuthor) return eventsNewestFirst;
  const out: E[] = [];
  for (const e of eventsNewestFirst) {
    out.push(e);
    if (!MOVE_EVENTS.has(e.event)) continue;
    const from = e.payload?.fromWorkspaceId;
    if (typeof from !== "string") { if (opts.treatAbsentFromAsReadable) continue; break; }
    if (!opts.canRead(from)) break;
  }
  return out;
}
