import { VECTORIZE_TOP_K_MULTIPLIER } from "../constants";
import type { EdgeProvenance, EdgeType } from "../graph/types";
import type { DistilledQuery } from "./distill";
import { edgeIntentCompatibility, type RecallIntent } from "./query-profile";
import { VIEW_SHARE } from "./root-selector";
import { queryRelevantWindow } from "./snippet";

const SUBSTRING_WEIGHT = 0.25;
const WEIGHT = {
  root: 0.30,
  linkedCoverage: 0.25,
  unionCoverage: 0.20,
  coverageGain: 0.10,
  edge: 0.05,
  provenance: 0.05,
  intent: 0.05,
} as const;
const MIN_NEIGHBORHOOD_SCORE = 0.5;
const MIN_EVIDENCE_GAIN = 0.1;
const MIN_LINKED_COVERAGE = 0.2;

export interface LinkedEvidenceInput {
  parentScore: number;
  parentContent: string;
  content: string;
  queryTokens: string[];
  evidenceTokens: string[];
  corpus: Pick<DistilledQuery, "df" | "total">;
  hop: number;
  edgeWeight: number;
  provenance: EdgeProvenance;
  hopDecay: number;
  replacementCoverage: number;
  intent: RecallIntent;
  edgeType: EdgeType;
}

export interface NeighborhoodEvidenceScore {
  eligible: boolean;
  score: number;
  coverage: number;
  coverageGain: number;
  rejection?: "no-linked-evidence" | "weak-neighborhood" | "no-evidence-gain";
}

/**
 * Ceiling on the seeds one recall expands from, whichever arm found them. It is
 * what keeps expandGraph's double-sided edge scan inside a single D1 statement:
 * a batch binds each id twice against D1_MAX_BOUND_PARAMS.
 */
export const GRAPH_SEED_MAX = 50;

/** The dense arm's fetch window, the size this budget has always been. */
const denseSeedWindow = (topK: number) => Math.min(topK * VECTORIZE_TOP_K_MULTIPLIER, GRAPH_SEED_MAX);

/**
 * The dense arm's graph seats, spent on rows the dense arm returned and on
 * nothing else.
 *
 * This number always meant "the dense arm's fetch window", but it used to be
 * handed the whole FUSED pool, so the two arms bid for one budget. Fusion gives
 * a keyword hit the sum of its matched IDF and a dense hit only 1/(k + rank),
 * so keyword-only rows outscore most of the dense arm: every one the real SQL
 * added took a seat from the bottom of the dense fetch, and a root the vector
 * arm did rank could fall out of the graph entirely. Truncating the dense arm
 * BY ITS OWN RANK is the design; being outbid by the other arm was not.
 */
export function graphSeedLimit(topK: number, denseCount: number): number {
  return Math.min(denseCount, denseSeedWindow(topK));
}

/**
 * The keyword arm's own graph seats, so it no longer bids for the dense arm's.
 *
 * Deliberately a fraction of the dense window rather than a matching budget:
 * the keyword arm fetches KEYWORD_CANDIDATE_LIMIT rows, far more than anything
 * should expand from, and a row only it returned is a seed on lexical evidence
 * alone. The fraction is the share selectGraphRoots already allots to its
 * lexical view, so lexical evidence keeps about the seats it always had — the
 * dense arm simply stops paying for them.
 */
export function lexicalSeedLimit(topK: number, lexicalOnlyCount: number, denseSeats: number): number {
  return Math.max(0, Math.min(
    lexicalOnlyCount,
    Math.ceil(denseSeedWindow(topK) * VIEW_SHARE.lexical),
    GRAPH_SEED_MAX - denseSeats,
  ));
}

export function relatedSlotLimit(topK: number): number {
  if (topK < 3) return 0;
  return topK < 6 ? 1 : 2;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface CoverageDetail {
  score: number;
  exactHighIdf: boolean;
}

export function queryCoverage(
  content: string,
  tokens: string[],
  corpus: Pick<DistilledQuery, "df" | "total">,
): CoverageDetail {
  const dedupedTokens = [...new Set(tokens.filter(Boolean))];
  if (!dedupedTokens.length) return { score: 0, exactHighIdf: false };

  // Matched against lowercased content, so lowercased here too. corpus.df is
  // keyed by the ORIGINAL token casing (raw-surface probes, #326, are never
  // lowercased by the tokenizer), so df lookups must use the original token —
  // mirrors the needle pattern in fuseDenseAndKeyword (search.ts).
  const needle = new Map(dedupedTokens.map(t => [t, t.toLowerCase()]));

  const hasCorpusIdf = !!corpus.df && !!corpus.total && dedupedTokens.every(t => corpus.df!.has(t));
  const weightOf = (token: string) => hasCorpusIdf
    ? Math.log(1 + corpus.total! / ((corpus.df!.get(token) ?? 0) + 1))
    : 1;
  const lower = content.toLowerCase();
  let matched = 0;
  let total = 0;
  let exactHighIdf = false;

  for (const t of dedupedTokens) {
    const weight = weightOf(t);
    total += weight;
    const lc = needle.get(t)!;
    const isExactMatch = new RegExp(`(?<![\\w])${escapeRegExp(lc)}(?![\\w])`).test(lower);
    if (isExactMatch) {
      matched += weight;
      exactHighIdf ||= !!corpus.df
        && !!corpus.total
        && (corpus.df.get(t) ?? Number.POSITIVE_INFINITY) <= corpus.total * 0.1;
    } else if (lower.includes(lc)) {
      matched += weight * SUBSTRING_WEIGHT;
    }
  }

  return { score: total > 0 ? matched / total : 0, exactHighIdf };
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function exactQueryMatchCount(content: string, tokens: string[]): number {
  const lower = content.toLowerCase();
  return [...new Set(tokens.map(token => token.toLowerCase()).filter(Boolean))]
    .filter(token => new RegExp(`(?<![\\w])${escapeRegExp(token)}(?![\\w])`).test(lower)).length;
}

export function scoreLinkedEvidence(input: LinkedEvidenceInput): NeighborhoodEvidenceScore {
  const linkedEvidence = queryRelevantWindow(
    input.content,
    [...input.queryTokens, ...input.evidenceTokens],
  );
  const parentCoverage = Math.max(
    queryCoverage(input.parentContent, input.queryTokens, input.corpus).score,
    queryCoverage(input.parentContent, input.evidenceTokens, input.corpus).score,
  );
  const precision = queryCoverage(linkedEvidence, input.queryTokens, input.corpus);
  const linkedCoverage = Math.max(
    precision.score,
    queryCoverage(linkedEvidence, input.evidenceTokens, input.corpus).score,
  );
  const unionContent = `${input.parentContent}\n${linkedEvidence}`;
  const unionCoverage = Math.max(
    queryCoverage(unionContent, input.queryTokens, input.corpus).score,
    queryCoverage(
      unionContent,
      input.evidenceTokens,
      input.corpus,
    ).score,
  );
  const coverageGain = Math.max(0, unionCoverage - parentCoverage);
  if (linkedCoverage === 0) {
    return { eligible: false, score: 0, coverage: linkedCoverage, coverageGain, rejection: "no-linked-evidence" };
  }

  const rootRelevance = clamp(input.parentScore * Math.pow(clamp(input.hopDecay), input.hop));

  const provenanceFactor = input.provenance === "explicit"
    ? 1
    : input.provenance === "system"
      ? 0.9
      : 0.8;
  const score = clamp(
    WEIGHT.root * rootRelevance
    + WEIGHT.linkedCoverage * clamp(linkedCoverage)
    + WEIGHT.unionCoverage * clamp(unionCoverage)
    + WEIGHT.coverageGain * clamp(coverageGain)
    + WEIGHT.edge * clamp(input.edgeWeight)
    + WEIGHT.provenance * provenanceFactor
    + WEIGHT.intent * edgeIntentCompatibility(input.intent, input.edgeType),
  );
  const meetsPrecisionGate = precision.exactHighIdf || exactQueryMatchCount(linkedEvidence, input.queryTokens) >= 2;
  const meetsLinkedEvidenceGate = (linkedCoverage >= MIN_LINKED_COVERAGE || precision.exactHighIdf)
    && meetsPrecisionGate;
  if (!meetsLinkedEvidenceGate || score < MIN_NEIGHBORHOOD_SCORE) {
    return { eligible: false, score: 0, coverage: linkedCoverage, coverageGain, rejection: "weak-neighborhood" };
  }
  if (unionCoverage < clamp(input.replacementCoverage) + MIN_EVIDENCE_GAIN) {
    return { eligible: false, score: 0, coverage: linkedCoverage, coverageGain, rejection: "no-evidence-gain" };
  }

  return {
    eligible: true,
    score,
    coverage: linkedCoverage,
    coverageGain,
  };
}
