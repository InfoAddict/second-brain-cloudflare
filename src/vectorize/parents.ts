/**
 * Long notes are stored as several vectors that share a `parentId`, so a query
 * for "the five nearest memories" that asks Vectorize for topK 5 can be filled
 * by five chunks of one note. Callers that want distinct memories ask for a
 * wider window and collapse it here.
 */
import { WRITE_PATH_TOPK } from "../constants";

export { WRITE_PATH_TOPK };

interface Scored { id: string; score: number; metadata?: unknown }

const parentOf = (m: Scored): string => ((m.metadata as { parentId?: unknown } | undefined)?.parentId as string | undefined) ?? m.id;

/** The best-scoring match of each distinct parent, best first, at most `limit` of them. */
export function nearestParents<T extends Scored>(matches: readonly T[], limit = 5): T[] {
  const best = new Map<string, T>();
  for (const m of matches) {
    const pid = parentOf(m);
    const cur = best.get(pid);
    if (!cur || m.score > cur.score) best.set(pid, m);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
