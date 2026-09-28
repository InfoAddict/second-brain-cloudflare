import { cosineSim } from "../recall/math";
import { decodeVector, type StandingCacheV1 } from "./codec";

export interface StandingFireCandidate {
  id: string;
  score: number;
  /** Index into the `caches` array this fire came from, so the caller can recover which workspace it is. */
  workspaceIndex: number;
}

export interface SelectStandingFiresOptions {
  threshold: number;
  maxFires: number;
  /** The current recall's project, if any (C3): an item scoped to a project fires only for a matching recall. */
  project?: { slug: string; aliases: string[] };
}

/**
 * Pure firing selection (Design 2.7): scores every cached item against the query vector, applies the project
 * filter, and returns the top `maxFires * 2` candidates so hydration can drop some (a row that no longer
 * qualifies at read time) and the renderer still keeps up to `maxFires`.
 */
export function selectStandingFires(
  query: Float32Array | number[], caches: readonly StandingCacheV1[], opts: SelectStandingFiresOptions,
): StandingFireCandidate[] {
  const projectSlugs = opts.project ? new Set([opts.project.slug, ...opts.project.aliases]) : undefined;
  const candidates: (StandingFireCandidate & { createdAt: number })[] = [];

  caches.forEach((cache, workspaceIndex) => {
    for (const item of cache.items) {
      if (item.projects.length && !item.projects.some(p => projectSlugs?.has(p))) continue;
      let best = -Infinity;
      for (const vec of item.vecs) best = Math.max(best, cosineSim(query, decodeVector(vec)));
      if (best >= opts.threshold) candidates.push({ id: item.id, score: best, workspaceIndex, createdAt: item.createdAt });
    }
  });

  candidates.sort((a, b) => b.score - a.score || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return candidates.slice(0, opts.maxFires * 2).map(({ id, score, workspaceIndex }) => ({ id, score, workspaceIndex }));
}
