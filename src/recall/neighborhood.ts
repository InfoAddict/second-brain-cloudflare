import { VECTORIZE_TOP_K_MULTIPLIER } from "../constants";
import type { EdgeProvenance, EdgeType } from "../graph/types";
import type { DistilledQuery } from "./distill";
import { edgeIntentCompatibility, type RecallIntent } from "./query-profile";
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

export function graphSeedLimit(topK: number, candidateCount: number): number {
  return Math.min(candidateCount, topK * VECTORIZE_TOP_K_MULTIPLIER, 50);
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
  const normalizedTokens = [...new Set(tokens.map(t => t.toLowerCase()).filter(Boolean))];
  if (!normalizedTokens.length) return { score: 0, exactHighIdf: false };

  const hasCorpusIdf = !!corpus.df && !!corpus.total && normalizedTokens.every(t => corpus.df!.has(t));
  const weightOf = (token: string) => hasCorpusIdf
    ? Math.log(1 + corpus.total! / ((corpus.df!.get(token) ?? 0) + 1))
    : 1;
  const lower = content.toLowerCase();
  let matched = 0;
  let total = 0;
  let exactHighIdf = false;

  for (const token of normalizedTokens) {
    const weight = weightOf(token);
    total += weight;
    const isExactMatch = new RegExp(`(?<![\\w])${escapeRegExp(token)}(?![\\w])`).test(lower);
    if (isExactMatch) {
      matched += weight;
      exactHighIdf ||= !!corpus.df
        && !!corpus.total
        && (corpus.df.get(token) ?? Number.POSITIVE_INFINITY) <= corpus.total * 0.1;
    } else if (lower.includes(token)) {
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
