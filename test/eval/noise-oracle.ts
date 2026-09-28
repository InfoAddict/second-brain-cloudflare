import { DEFAULTS, type Config } from "../../src/config";
import {
  applyOccupancyCap, collapseLift, collapseNearDuplicates, liftFor,
  sourceClass, type CollapseCandidate, type OccupancyCandidate,
} from "../../src/recall/source-trust";
import type { CorpusEntry } from "./corpus/types";

// IMPORTANT (Codex review, T-0089.3.5 round 2): the correct candidate below must be built ONLY
// from lane R's production functions (`src/recall/source-trust.ts`, v4/t3-r 60b84f78) and fields
// production actually has at rank time: a candidate's own declared source, tags, content and
// createdAt, and the query TEXT (a legitimate production input, unlike the answer key). An earlier
// draft's `collapse`/`sourceWeightDemote` took the query's `gold` and exempted it from being
// dropped or demoted — a candidate that can see the answer key is an oracle, not a reranker, and
// the gate it produced proved nothing about production behavior. `Candidate` below is built from a
// `CorpusEntry` alone, so a `GoldenQuery`'s `gold` field cannot reach it even by accident: there is
// no parameter it could come in on. `noise-gate.test.ts`'s structural test additionally proves this
// at runtime, not just by type, with a Proxy that throws if anything downstream ever reads `.gold`.

export type Candidate = CollapseCandidate & OccupancyCandidate;

export const toCandidate = (e: Pick<CorpusEntry, "id" | "content" | "source" | "tags" | "createdAt">): Candidate => ({
  id: e.id, content: e.content, source: e.source, tags: e.tags, createdAt: e.createdAt,
});

/** D3.1's approved starting values (2026-09-26): mild demotion plus a 40% occupancy cap. */
export const TUNED_CFG: Readonly<Config> = Object.freeze({
  ...DEFAULTS, SOURCE_WEIGHT_MIRROR: 0.85, SOURCE_WEIGHT_TRANSCRIPT: 0.9, SOURCE_WEIGHT_SYSTEM: 0.95, MIRROR_MAX_SHARE: 0.4,
});

/**
 * The production Track 3 pipeline (T-0089.3.1), replayed on a recorded top-10 in production's own
 * order (`src/recall/search.ts`: collapse, then the occupancy cap; `sourceWeight` is applied
 * earlier still, before ranking, and is deliberately NOT simulated here: it multiplies a raw fused
 * score in `math.ts`, and a recorded report carries only the final rank order, not scores, so there
 * is nothing to replay it against. `includeTransactional: true` on the cap's lift matches this
 * corpus's `email-control` queries, half of which are transactional ("what is the confirmation
 * code for the flight booking") rather than source-named ("in my email..."); whether that lift
 * should default on is exactly the open tuning question this eval exists to inform (11.2, grid
 * axis L in the Track 3 spec), so both settings are reported below, not asserted as settled.
 */
export function productionRerank(
  rankedIds: readonly string[], queryText: string, byId: ReadonlyMap<string, CorpusEntry>, opts: { includeTransactional: boolean } = { includeTransactional: true },
): string[] {
  const candidates: Candidate[] = rankedIds.map(id => toCandidate(byId.get(id)!));
  const collapsed = collapseLift(queryText, undefined) ? candidates : collapseNearDuplicates(candidates).kept;
  const capped = liftFor(queryText, undefined, opts.includeTransactional) ? collapsed : applyOccupancyCap(collapsed, TUNED_CFG.MIRROR_MAX_SHARE, null);
  return capped.map(c => c.id);
}

/** Wrong candidate 1: demotes every mirror/transcript row below every direct row, on every query, with no source-word lift. Breaks the "wants the mail/transcript" controls. */
export function blanketDemote(ranked: readonly string[], byId: ReadonlyMap<string, CorpusEntry>): string[] {
  const direct: string[] = [], rest: string[] = [];
  for (const id of ranked) {
    const e = byId.get(id);
    (e && sourceClass(e.source, e.tags) !== "direct" ? rest : direct).push(id);
  }
  return [...direct, ...rest];
}

/** Wrong candidate 2: drops every mirror/transcript row outright, on every query. */
export function dropNonDirect(ranked: readonly string[], byId: ReadonlyMap<string, CorpusEntry>): string[] {
  return ranked.filter(id => { const e = byId.get(id); return !e || sourceClass(e.source, e.tags) === "direct"; });
}

/** Wrong candidate 3: pure recency, ignoring source class and relevance entirely. */
export function pureRecency(ranked: readonly string[], byId: ReadonlyMap<string, CorpusEntry>): string[] {
  return [...ranked].sort((a, b) => (byId.get(b)?.createdAt ?? 0) - (byId.get(a)?.createdAt ?? 0));
}
