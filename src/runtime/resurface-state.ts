import type { Env } from "../env";

/**
 * What GET /brief remembers about its own resurface pick, one record per
 * member (keyed on personalWorkspaceId, the same per-identity anchor
 * src/prompt-capsule/cache.ts keys its cache on). Same KV binding and
 * workspace-key style as src/runtime/night-summary.ts.
 *
 * `day` and `shownId` give same-day stability: the pick does not change on a
 * second app open the same day. `recent` is the rolling memory of what was
 * shown, so tomorrow's pick does not repeat this week's; `dismissed` is what
 * the member explicitly said "not this one" to, and never comes back.
 */
export interface ResurfaceState {
  day: number;
  shownId: string | null;
  recent: { id: string; day: number }[];
  dismissed: string[];
}

/** How many past picks `recent` remembers, oldest dropped first. */
const RECENT_CAP = 30;
/** How many dismissals `dismissed` remembers, oldest dropped first. */
const DISMISSED_CAP = 60;

const EMPTY_STATE: ResurfaceState = { day: -1, shownId: null, recent: [], dismissed: [] };

export function resurfaceStateKey(workspaceId: string): string {
  return `resurface:${workspaceId}`;
}

/** Never throws: a read failure is treated as "no state yet", matching night-summary.ts. */
export async function readResurfaceState(env: Env, workspaceId: string): Promise<ResurfaceState> {
  try {
    const raw = await env.OAUTH_KV.get(resurfaceStateKey(workspaceId));
    if (!raw) return { ...EMPTY_STATE };
    const parsed = JSON.parse(raw) as Partial<ResurfaceState>;
    return {
      day: typeof parsed.day === "number" ? parsed.day : -1,
      shownId: typeof parsed.shownId === "string" ? parsed.shownId : null,
      recent: Array.isArray(parsed.recent)
        ? parsed.recent.filter((r): r is { id: string; day: number } =>
            !!r && typeof r.id === "string" && typeof r.day === "number")
        : [],
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed.filter((d): d is string => typeof d === "string") : [],
    };
  } catch (e) {
    console.error(`Resurface state read failed for workspace ${workspaceId} (non-fatal):`, e);
    return { ...EMPTY_STATE };
  }
}

/** Never throws, matching every other nightly/brief KV write in this codebase. */
export async function writeResurfaceState(env: Env, workspaceId: string, state: ResurfaceState): Promise<void> {
  try {
    await env.OAUTH_KV.put(resurfaceStateKey(workspaceId), JSON.stringify(state));
  } catch (e) {
    console.error(`Resurface state write failed for workspace ${workspaceId} (non-fatal):`, e);
  }
}

/** Records today's pick, folding it into `recent` (capped, de-duplicated by id). */
export function withShown(state: ResurfaceState, id: string, day: number): ResurfaceState {
  const recent = [...state.recent.filter(r => r.id !== id), { id, day }].slice(-RECENT_CAP);
  return { ...state, day, shownId: id, recent };
}

/** Records a dismissal, and clears the same-day pick if it was the dismissed one. */
export function withDismissed(state: ResurfaceState, id: string): ResurfaceState {
  const dismissed = state.dismissed.includes(id) ? state.dismissed : [...state.dismissed, id].slice(-DISMISSED_CAP);
  return { ...state, dismissed, shownId: state.shownId === id ? null : state.shownId };
}

/**
 * Ids the next selection must not draw: everything dismissed, plus anything
 * shown within `windowDays` of `today` (both day numbers, see brief.ts's
 * dayNumber). Deduplicated, because the same id can appear via both paths.
 *
 * Recently-shown ids come first, most recent first: the caller caps how many
 * of these get bound into a query (D1's parameter limit), and a truncation
 * should drop the oldest, least useful exclusions rather than the freshest —
 * repeating yesterday's pick is worse than repeating one from three weeks ago.
 * Dismissals fill whatever room is left.
 */
export function excludedIds(state: ResurfaceState, today: number, windowDays: number): string[] {
  const recentIds = state.recent
    .filter(r => today - r.day < windowDays)
    .sort((a, b) => b.day - a.day)
    .map(r => r.id);
  return [...new Set([...recentIds, ...state.dismissed])];
}
