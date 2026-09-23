/**
 * Frozen pre-plan baseline scoring, shared by every recall root-quality
 * benchmark (development/holdout, hidden validation, and their real-SQL
 * harness in test/eval/legacy/). Extracted verbatim from the two original mock-based test
 * files, which had byte-identical copies of this logic — a single copy
 * means the "frozen baseline" all of them compare against cannot drift
 * between suites.
 */
import { DEFAULTS } from "../../src/config";
import { KEYWORD_CANDIDATE_LIMIT, KEYWORD_MAX_TOKENS } from "../../src/constants";
import { graphSeedLimit, relatedSlotLimit } from "../../src/recall/neighborhood";
import { mmrRerank, rerankWithTimeDecay, type VectorizeMatch } from "../../src/recall/math";
import type { RootCandidate } from "../../src/recall/root-selector";
import { rrfFuse } from "../../src/recall/rrf";
import type { CandidateFixture, RootQualityCase } from "../fixtures/recall-root-quality";

export const rawCandidates = (c: RootQualityCase) =>
  c.candidates.filter(candidate => candidate.denseScore !== undefined || candidate.keywordCandidate);

export const directTopFourRegressed = (currentIds: string[], baselineIds: string[]) =>
  JSON.stringify(currentIds.slice(0, 4)) !== JSON.stringify(baselineIds.slice(0, 4));

export function baselineRootIds(candidates: RootCandidate[], topK: number, lambda: number): string[] {
  return mmrRerank(candidates, lambda, graphSeedLimit(topK, candidates.length))
    .map(candidate => candidate.parentId);
}

export function baselineLinkedEligible(content: string, tokens: string[]): boolean {
  const lower = content.toLowerCase();
  return tokens.some(token => lower.includes(token.toLowerCase()));
}

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function frozenBaselineCorpus(c: RootQualityCase, tokens: string[]) {
  return c.failureShape === "weak-generic-neighbor" || c.failureShape === "long-parent-pollution"
    ? { df: null, total: null }
    : { df: new Map(tokens.map(token => [token, 2])), total: 100 };
}

/**
 * "labels" (default): the keyword pool is the rows the fixture labeled
 * keywordCandidate, which is what the mock D1 serves. "like": the pool a real
 * LIKE builds (rows containing any of the first KEYWORD_MAX_TOKENS tokens,
 * newest first, capped), so a real-SQL run and its baseline fuse the same inputs.
 */
export type KeywordPool = "labels" | "like";

export function frozenPrePlanFused(c: RootQualityCase, tokens: string[], pool: KeywordPool = "labels"): VectorizeMatch[] {
  const dense = c.candidates
    .filter((candidate): candidate is CandidateFixture & { denseScore: number } => candidate.denseScore !== undefined)
    .slice()
    .sort((a, b) => b.denseScore - a.denseScore);
  const denseById = new Map(dense.map(candidate => [candidate.id, candidate]));
  const likeTerms = tokens.slice(0, KEYWORD_MAX_TOKENS).map(token => token.toLowerCase());
  const keyword = pool === "labels"
    ? c.candidates.filter(candidate => candidate.keywordCandidate)
    : c.candidates
        .filter(candidate => likeTerms.some(term => candidate.content.toLowerCase().includes(term)))
        .sort((a, b) => (b.createdAt ?? 1) - (a.createdAt ?? 1))
        .slice(0, KEYWORD_CANDIDATE_LIMIT);
  const corpus = frozenBaselineCorpus(c, tokens);
  const hasCorpusIdf = !!corpus.df && !!corpus.total && tokens.every(token => corpus.df!.has(token));
  const keywordN = keyword.length || 1;
  const keywordDf = new Map(tokens.map(token => [
    token,
    keyword.filter(candidate => candidate.content.toLowerCase().includes(token.toLowerCase())).length,
  ]));
  const idf = (token: string) => hasCorpusIdf
    ? Math.log(1 + corpus.total! / ((corpus.df!.get(token) ?? 0) + 1))
    : Math.log(1 + keywordN / ((keywordDf.get(token) ?? 0) + 1));
  const keywordRanked = keyword
    .map(candidate => {
      const lower = candidate.content.toLowerCase();
      const weight = tokens.reduce((sum, token) => {
        const normalized = token.toLowerCase();
        if (!lower.includes(normalized)) return sum;
        const exact = new RegExp(`(?<![\\w])${escapeRegExp(normalized)}(?![\\w])`).test(lower);
        return sum + idf(token) * (exact ? 1 : DEFAULTS.SUBSTRING_MATCH_WEIGHT);
      }, 0);
      return { candidate, weight };
    })
    .filter(row => row.weight > 0)
    .sort((a, b) => b.weight - a.weight
      || (b.candidate.createdAt ?? 1) - (a.candidate.createdAt ?? 1)
      || a.candidate.id.localeCompare(b.candidate.id));
  const fused = rrfFuse(
    dense.map(candidate => candidate.id),
    keywordRanked.map(row => ({ id: row.candidate.id, weight: row.weight })),
  );
  const byId = new Map(c.candidates.map(candidate => [candidate.id, candidate]));
  return [...fused].map(([id, score]) => {
    const candidate = byId.get(id)!;
    const denseCandidate = denseById.get(id);
    return {
      id,
      score,
      metadata: denseCandidate
        ? { parentId: id, content: denseCandidate.vectorContent, created_at: denseCandidate.createdAt ?? 1 }
        : { parentId: id, content: candidate.content, created_at: candidate.createdAt ?? 1, tags: candidate.tags ?? [] },
    };
  });
}

export function baselineRecall(c: RootQualityCase, tokens: string[], topK: number, pool: KeywordPool = "labels"): { outputIds: string[]; directIds: string[]; rootIds: string[] } {
  // A real DB carries recall_count and tags on every row, labeled or not.
  const fixtures = pool === "like" ? c.candidates : rawCandidates(c);
  const recallCounts = new Map(fixtures.map(candidate => [candidate.id, candidate.recallCount ?? 0]));
  const tags = new Map(fixtures.map(candidate => [candidate.id, [...(candidate.tags ?? [])]]));
  const reranked = rerankWithTimeDecay(
    frozenPrePlanFused(c, tokens, pool),
    recallCounts,
    new Map(),
    [],
    new Map(),
    new Map(),
    tags,
    DEFAULTS,
  );
  const candidates: RootCandidate[] = reranked.map(match => ({
    ...match,
    parentId: match.id,
    rootScore: match.score,
    localEvidence: c.candidates.find(candidate => candidate.id === match.id)?.vectorContent ?? "",
    tags: tags.get(match.id) ?? [],
    lexicalCoverage: 0,
    metadataAlignment: 0,
  }));
  const roots = new Set(baselineRootIds(candidates, topK, DEFAULTS.MMR_LAMBDA));
  const directIds = mmrRerank(reranked, DEFAULTS.MMR_LAMBDA, topK).map(candidate => candidate.id);
  const rows = new Map(c.candidates.map(candidate => [candidate.id, candidate]));
  const related = c.edges
    .flatMap(edge => {
      const linkedId = roots.has(edge.sourceId)
        ? edge.targetId
        : roots.has(edge.targetId)
          ? edge.sourceId
          : undefined;
      if (!linkedId || directIds.includes(linkedId)) return [];
      const linked = rows.get(linkedId);
      return linked && baselineLinkedEligible(linked.content, tokens) ? [linkedId] : [];
    })
    .slice(0, relatedSlotLimit(topK));
  return {
    outputIds: [...directIds.slice(0, topK - related.length), ...related],
    directIds,
    rootIds: [...roots],
  };
}
