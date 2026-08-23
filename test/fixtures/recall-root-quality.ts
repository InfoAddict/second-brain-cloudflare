import type { EdgeProvenance, EdgeType } from "../../src/graph/types";
import type { RecallIntent } from "../../src/recall/query-profile";

export type RootQualitySplit = "development" | "holdout";
export type RootQualityDomain = "personal" | "enterprise" | "product" | "architecture";
export type RootFailureShape =
  | "crowded-lexical-root"
  | "popular-broad-summary"
  | "long-parent-pollution"
  | "weak-generic-neighbor"
  | "absent-cluster-control";

export interface CandidateFixture {
  readonly id: string;
  readonly content: string;
  /** Query-local Vectorize chunk text. Absent on keyword-only and linked rows. */
  readonly vectorContent?: string;
  /** Raw Vectorize similarity. Absent means this row is not in the dense pool. */
  readonly denseScore?: number;
  /** Include this row in the controlled keyword arm. */
  readonly keywordCandidate?: boolean;
  readonly recallCount?: number;
  readonly createdAt?: number;
  readonly tags?: readonly string[];
}

export interface EdgeFixture {
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: EdgeType;
  readonly weight: number;
  readonly provenance: EdgeProvenance;
}

export interface RootQualityCase {
  readonly split: RootQualitySplit;
  readonly domain: RootQualityDomain;
  readonly failureShape: RootFailureShape;
  readonly query: string;
  readonly intent: RecallIntent;
  readonly candidates: readonly CandidateFixture[];
  readonly edges: readonly EdgeFixture[];
  readonly authoritativeIds: readonly string[];
  readonly acceptableRootIds: readonly string[];
  readonly candidateAvailable: boolean;
}

const OLD = 1;

function directCandidates(prefix: string, authoritativeFifthId?: string): CandidateFixture[] {
  return Array.from({ length: 5 }, (_, index) => ({
    id: index === 4 && authoritativeFifthId ? authoritativeFifthId : `${prefix}-direct-${index}`,
    content: index === 4 && authoritativeFifthId
      ? "The controlled record contains the authoritative current answer."
      : `General direct record ${index} for the controlled corpus.`,
    vectorContent: `General direct record ${index}.`,
    denseScore: 0.99 - index * 0.01,
    createdAt: OLD,
  }));
}

function semanticDistractors(prefix: string, count: number, start = 0.94): CandidateFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-semantic-${index}`,
    content: `Broad background summary ${index} without the decisive evidence.`,
    vectorContent: `Broad background summary ${index}.`,
    denseScore: start - index * 0.01,
    createdAt: OLD,
  }));
}

function crowdedCandidates(
  prefix: string,
  rootId: string,
  answerId: string,
  rootChunk: string,
  answer: string,
  keywordText: string,
): CandidateFixture[] {
  return [
    ...directCandidates(prefix),
    ...semanticDistractors(prefix, 9),
    {
      id: rootId,
      content: "A compact decision marker whose parent text omits the query wording.",
      vectorContent: rootChunk,
      denseScore: 0.76,
      createdAt: OLD,
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `${prefix}-keyword-${index}`,
      content: `${keywordText} background index ${index}.`,
      keywordCandidate: true,
      createdAt: OLD,
    })),
    { id: answerId, content: answer, createdAt: OLD },
  ];
}

function popularityCandidates(
  prefix: string,
  rootId: string,
  popularId: string,
  answerId: string,
  answer: string,
  keywordText: string,
): CandidateFixture[] {
  return [
    ...directCandidates(prefix),
    ...semanticDistractors(prefix, 8),
    {
      id: rootId,
      content: "A specific decision marker with intentionally neutral lexical evidence.",
      vectorContent: "Specific decision marker.",
      denseScore: 0.81,
      createdAt: OLD,
    },
    {
      id: popularId,
      content: "A popular broad summary with no authoritative answer.",
      vectorContent: "Popular broad summary.",
      denseScore: 0.8,
      recallCount: 10_000,
      createdAt: OLD,
    },
    {
      id: `${prefix}-keyword-leader`,
      content: keywordText,
      keywordCandidate: true,
      createdAt: OLD,
    },
    { id: answerId, content: answer, createdAt: OLD },
  ];
}

function longParentCandidates(
  prefix: string,
  rootId: string,
  answerId: string,
  queryTerms: readonly [string, string, string, string],
): CandidateFixture[] {
  const [first, second, third, fourth] = queryTerms;
  return [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `${prefix}-direct-${index}`,
      content: `${first} ${second} ${third} replacement evidence ${index}.`,
      vectorContent: `${first} ${second} ${third} replacement chunk ${index}.`,
      denseScore: 0.99 - index * 0.01,
      createdAt: OLD,
    })),
    {
      id: rootId,
      content: `${fourth} occurs in an unrelated parent section. ${"Unrelated archival material. ".repeat(30)}`,
      vectorContent: `${first} ${second} local chunk`,
      denseScore: 0.75,
      createdAt: OLD,
    },
    { id: answerId, content: `${third} ${fourth} linked authoritative evidence.`, createdAt: OLD },
  ];
}

function weakNeighborCandidates(
  prefix: string,
  authoritativeDirectId: string,
  rootId: string,
  weakId: string,
  weakContent: string,
): CandidateFixture[] {
  const direct = directCandidates(prefix, authoritativeDirectId);
  const root: CandidateFixture = {
    id: rootId,
    denseScore: 0.6,
    content: "A weakly relevant root marker.",
    vectorContent: "A weakly relevant root marker.",
    createdAt: OLD,
  };
  return [...direct, root, { id: weakId, content: weakContent, createdAt: OLD }];
}

function absentCandidates(prefix: string, answerId: string): CandidateFixture[] {
  return [...directCandidates(prefix), { id: answerId, content: "Authoritative evidence outside the raw pool.", createdAt: OLD }];
}

function holdoutDirectCandidates(
  prefix: string,
  count: number,
  start: number,
  step: number,
  authoritativeFifthId?: string,
): CandidateFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index === 4 && authoritativeFifthId ? authoritativeFifthId : `${prefix}-direct-${index}`,
    content: index === 4 && authoritativeFifthId
      ? "The controlled holdout record contains the authoritative current answer."
      : `Holdout direct record ${index} with a distinct score geometry.`,
    vectorContent: `Holdout direct evidence ${index}.`,
    denseScore: start - index * step,
    createdAt: OLD + index,
    recallCount: index === 1 ? 3 : 0,
  }));
}

function holdoutCrowdedCandidates(
  prefix: string,
  rootId: string,
  answerId: string,
  rootChunk: string,
  answer: string,
  keywordText: string,
  directCount: number,
  semanticCount: number,
  keywordCount: number,
  rootScore: number,
): CandidateFixture[] {
  return [
    ...holdoutDirectCandidates(prefix, directCount, 0.995, 0.013),
    ...Array.from({ length: semanticCount }, (_, index) => ({
      id: `${prefix}-semantic-${index}`,
      content: `Holdout background cluster ${index} without the linked decision.`,
      vectorContent: `Holdout background vector ${index}.`,
      denseScore: 0.89 - index * 0.017,
      createdAt: 30 + index,
      recallCount: index === 0 ? 11 : 0,
    })),
    { id: rootId, content: "A terse holdout root parent.", vectorContent: rootChunk, denseScore: rootScore, createdAt: 17 },
    ...Array.from({ length: keywordCount }, (_, index) => ({
      id: `${prefix}-keyword-${index}`,
      content: `${keywordText} alternate lexical distractor ${index}.`,
      keywordCandidate: true,
      createdAt: 80 - index * 2,
      recallCount: index === keywordCount - 1 ? 5 : 0,
    })),
    { id: answerId, content: answer, createdAt: 9 },
    { id: `${prefix}-edge-decoy`, content: "A linked but irrelevant holdout branch.", createdAt: 8 },
  ];
}

function holdoutPopularCandidates(
  prefix: string,
  rootId: string,
  popularId: string,
  answerId: string,
  rootChunk: string,
  answer: string,
  keywordText: string,
  directCount: number,
  semanticCount: number,
  keywordCount: number,
  recallCount: number,
): CandidateFixture[] {
  return [
    ...holdoutDirectCandidates(prefix, directCount, 0.997, 0.011),
    ...Array.from({ length: semanticCount }, (_, index) => ({
      id: `${prefix}-semantic-${index}`,
      content: `Holdout operating summary ${index}.`,
      vectorContent: `Operating summary vector ${index}.`,
      denseScore: 0.9 - index * 0.019,
      createdAt: 44 + index,
      recallCount: index === 1 ? 7 : 0,
    })),
    { id: rootId, content: "Specific holdout decision marker.", vectorContent: rootChunk, denseScore: 0.765, createdAt: 12 },
    { id: popularId, content: "Frequently recalled broad holdout digest.", vectorContent: "Broad digest.", denseScore: 0.735, recallCount, createdAt: 3 },
    ...Array.from({ length: keywordCount }, (_, index) => ({
      id: `${prefix}-keyword-${index}`,
      content: `${keywordText} broad lexical digest ${index}.`,
      keywordCandidate: true,
      createdAt: 100 - index,
      recallCount: index === 0 ? 19 : 0,
    })),
    { id: answerId, content: answer, createdAt: 2 },
    { id: `${prefix}-edge-decoy`, content: "An irrelevant but linked digest branch.", createdAt: 1 },
  ];
}

function holdoutLongCandidates(
  prefix: string,
  rootId: string,
  answerId: string,
  queryTerms: readonly [string, string, string, string],
  directCount: number,
  tailCount: number,
): CandidateFixture[] {
  const [first, second, third, fourth] = queryTerms;
  return [
    ...Array.from({ length: directCount }, (_, index) => ({
      id: `${prefix}-direct-${index}`,
      content: `${first} ${second} ${third} replacement evidence ${index}.`,
      vectorContent: `${first} ${second} ${third} replacement chunk ${index}.`,
      denseScore: 0.996 - index * 0.014,
      createdAt: 70 + index,
      recallCount: index === 2 ? 9 : 0,
    })),
    ...Array.from({ length: tailCount }, (_, index) => ({
      id: `${prefix}-tail-${index}`,
      content: `Holdout tail distractor ${index}.`,
      vectorContent: `Tail vector ${index}.`,
      denseScore: 0.78 - index * 0.021,
      createdAt: 40 + index,
    })),
    {
      id: rootId,
      content: `${fourth} appears in an unrelated archival section. ${"Neutral archive text. ".repeat(28)}`,
      vectorContent: `${first} ${second} local chunk`,
      denseScore: 0.69,
      createdAt: 13,
    },
    { id: answerId, content: `${third} ${fourth} linked authoritative evidence.`, createdAt: 6 },
    { id: `${prefix}-edge-decoy`, content: `${first} generic branch only.`, createdAt: 5 },
  ];
}

function holdoutWeakCandidates(
  prefix: string,
  authoritativeId: string,
  rootId: string,
  weakId: string,
  weakContent: string,
  tailCount: number,
  rootScore: number,
): CandidateFixture[] {
  return [
    ...holdoutDirectCandidates(prefix, 5, 0.998, 0.012, authoritativeId),
    ...Array.from({ length: tailCount }, (_, index) => ({
      id: `${prefix}-tail-${index}`,
      content: `Non-authoritative holdout tail ${index}.`,
      vectorContent: `Tail ${index}.`,
      denseScore: rootScore + 0.035 - index * 0.08,
      createdAt: 20 + index,
      recallCount: index === 0 ? 13 : 0,
    })),
    { id: rootId, content: "Low-ranked holdout root.", vectorContent: "Low-ranked root.", denseScore: rootScore, createdAt: 4 },
    { id: weakId, content: weakContent, createdAt: 3 },
  ];
}

function holdoutAbsentCandidates(prefix: string, answerId: string, denseCount: number): CandidateFixture[] {
  return [
    ...holdoutDirectCandidates(prefix, denseCount, 0.996, 0.018),
    { id: answerId, content: "Authoritative holdout evidence outside both raw arms.", createdAt: 2 },
  ];
}

const decided = (sourceId: string, targetId: string): EdgeFixture => ({
  sourceId,
  targetId,
  type: "decided",
  weight: 1,
  provenance: "explicit",
});

const weak = (sourceId: string, targetId: string): EdgeFixture => ({
  sourceId,
  targetId,
  type: "relates_to",
  weight: 0.1,
  provenance: "inferred",
});

/**
 * Frozen before benchmark assertions or constant tuning. Authoritative and root IDs are
 * intentionally literal in this manifest so the implementation cannot manufacture its
 * own expected answers. The (domain index + shape index) parity assignment yields ten
 * cases per split and places every failure shape in both splits.
 */
export const ROOT_QUALITY_CASES: readonly RootQualityCase[] = [
  {
    split: "development", domain: "personal", failureShape: "crowded-lexical-root",
    query: "why did the cedar itinerary change", intent: "causal",
    candidates: crowdedCandidates("personal-crowded", "personal-crowded-root", "personal-crowded-answer", "cedar itinerary change", "The cedar itinerary changed because the venue moved the reservation.", "cedar itinerary"),
    edges: [decided("personal-crowded-root", "personal-crowded-answer")],
    authoritativeIds: ["personal-crowded-answer"], acceptableRootIds: ["personal-crowded-root"], candidateAvailable: true,
  },
  {
    split: "holdout", domain: "personal", failureShape: "popular-broad-summary",
    query: "which harbor rota policy remains active now", intent: "current",
    candidates: holdoutPopularCandidates("personal-popular", "personal-popular-root", "personal-popular-summary", "personal-popular-answer", "harbor rota policy", "The active harbor rota policy assigns the west team each Friday.", "harbor rota", 6, 6, 4, 50_000),
    edges: [
      { sourceId: "personal-popular-root", targetId: "personal-popular-answer", type: "supersedes", weight: 0.81, provenance: "system" },
      { sourceId: "personal-popular-root", targetId: "personal-popular-edge-decoy", type: "relates_to", weight: 0.42, provenance: "inferred" },
    ],
    authoritativeIds: ["personal-popular-answer"], acceptableRootIds: ["personal-popular-root"], candidateAvailable: true,
  },
  {
    split: "development", domain: "personal", failureShape: "long-parent-pollution",
    query: "maple venue booking permit", intent: "direct",
    candidates: longParentCandidates("personal-long", "personal-long-root", "personal-long-answer", ["maple", "venue", "booking", "permit"]),
    edges: [decided("personal-long-root", "personal-long-answer")],
    authoritativeIds: ["personal-long-answer"], acceptableRootIds: ["personal-long-root"], candidateAvailable: true,
  },
  {
    split: "holdout", domain: "personal", failureShape: "weak-generic-neighbor",
    query: "neighborhood allocation status planning review update summary notes archive", intent: "direct",
    candidates: holdoutWeakCandidates("personal-weak", "personal-weak-direct-answer", "personal-weak-root", "personal-weak-neighbor", "Neighborhood allocation overview.", 2, 0.52),
    edges: [
      { sourceId: "personal-weak-neighbor", targetId: "personal-weak-root", type: "relates_to", weight: 0.18, provenance: "system" },
      { sourceId: "personal-weak-root", targetId: "personal-weak-tail-1", type: "follows", weight: 0.29, provenance: "inferred" },
    ],
    authoritativeIds: ["personal-weak-direct-answer"], acceptableRootIds: ["personal-weak-root"], candidateAvailable: true,
  },
  {
    split: "development", domain: "personal", failureShape: "absent-cluster-control",
    query: "what happened before the studio move", intent: "chronology",
    candidates: absentCandidates("personal-absent", "personal-absent-answer"), edges: [],
    authoritativeIds: ["personal-absent-answer"], acceptableRootIds: [], candidateAvailable: false,
  },

  {
    split: "holdout", domain: "enterprise", failureShape: "crowded-lexical-root",
    query: "reason cobalt runtime ownership switched", intent: "causal",
    candidates: holdoutCrowdedCandidates("enterprise-crowded", "enterprise-crowded-root", "enterprise-crowded-answer", "cobalt runtime ownership", "Cobalt runtime ownership switched because the vendor support boundary moved.", "cobalt runtime", 6, 7, 7, 0.68),
    edges: [
      { sourceId: "enterprise-crowded-root", targetId: "enterprise-crowded-answer", type: "caused_by", weight: 0.83, provenance: "system" },
      { sourceId: "enterprise-crowded-root", targetId: "enterprise-crowded-edge-decoy", type: "relates_to", weight: 0.37, provenance: "inferred" },
    ],
    authoritativeIds: ["enterprise-crowded-answer"], acceptableRootIds: ["enterprise-crowded-root"], candidateAvailable: true,
  },
  {
    split: "development", domain: "enterprise", failureShape: "popular-broad-summary",
    query: "current atlas support model", intent: "current",
    candidates: popularityCandidates("enterprise-popular", "enterprise-popular-root", "enterprise-popular-summary", "enterprise-popular-answer", "The current atlas support model assigns a named rotation owner.", "atlas support model"),
    edges: [decided("enterprise-popular-root", "enterprise-popular-answer")],
    authoritativeIds: ["enterprise-popular-answer"], acceptableRootIds: ["enterprise-popular-root"], candidateAvailable: true,
  },
  {
    split: "holdout", domain: "enterprise", failureShape: "long-parent-pollution",
    query: "ember cutover validation archive", intent: "direct",
    candidates: holdoutLongCandidates("enterprise-long", "enterprise-long-root", "enterprise-long-answer", ["ember", "cutover", "validation", "archive"], 6, 1),
    edges: [
      { sourceId: "enterprise-long-root", targetId: "enterprise-long-answer", type: "follows", weight: 0.84, provenance: "system" },
      { sourceId: "enterprise-long-root", targetId: "enterprise-long-edge-decoy", type: "relates_to", weight: 0.33, provenance: "inferred" },
    ],
    authoritativeIds: ["enterprise-long-answer"], acceptableRootIds: ["enterprise-long-root"], candidateAvailable: true,
  },
  {
    split: "development", domain: "enterprise", failureShape: "weak-generic-neighbor",
    query: "delivery control status review planning update summary", intent: "direct",
    candidates: weakNeighborCandidates("enterprise-weak", "enterprise-weak-direct-answer", "enterprise-weak-root", "enterprise-weak-neighbor", "Delivery control overview."),
    edges: [weak("enterprise-weak-root", "enterprise-weak-neighbor")],
    authoritativeIds: ["enterprise-weak-direct-answer"], acceptableRootIds: ["enterprise-weak-root"], candidateAvailable: true,
  },
  {
    split: "holdout", domain: "enterprise", failureShape: "absent-cluster-control",
    query: "reason orchid scheduler backlog policy shifted recently", intent: "causal",
    candidates: holdoutAbsentCandidates("enterprise-absent", "enterprise-absent-answer", 7),
    edges: [{ sourceId: "enterprise-absent-direct-0", targetId: "enterprise-absent-direct-1", type: "follows", weight: 0.31, provenance: "system" }],
    authoritativeIds: ["enterprise-absent-answer"], acceptableRootIds: [], candidateAvailable: false,
  },

  {
    split: "development", domain: "product", failureShape: "crowded-lexical-root",
    query: "why did the beacon launch change", intent: "causal",
    candidates: crowdedCandidates("product-crowded", "product-crowded-root", "product-crowded-answer", "beacon launch change", "The beacon launch changed because the review window opened earlier.", "beacon launch"),
    edges: [decided("product-crowded-root", "product-crowded-answer")],
    authoritativeIds: ["product-crowded-answer"], acceptableRootIds: ["product-crowded-root"], candidateAvailable: true,
  },
  {
    split: "holdout", domain: "product", failureShape: "popular-broad-summary",
    query: "which compass activation path is still preferred", intent: "current",
    candidates: holdoutPopularCandidates("product-popular", "product-popular-root", "product-popular-summary", "product-popular-answer", "compass activation path", "The preferred compass activation path begins with a sample workspace.", "compass activation", 7, 6, 5, 25_000),
    edges: [
      { sourceId: "product-popular-root", targetId: "product-popular-answer", type: "caused_by", weight: 0.76, provenance: "inferred" },
      { sourceId: "product-popular-root", targetId: "product-popular-edge-decoy", type: "relates_to", weight: 0.48, provenance: "system" },
    ],
    authoritativeIds: ["product-popular-answer"], acceptableRootIds: ["product-popular-root"], candidateAvailable: true,
  },
  {
    split: "development", domain: "product", failureShape: "long-parent-pollution",
    query: "mosaic rollout activation trial", intent: "direct",
    candidates: longParentCandidates("product-long", "product-long-root", "product-long-answer", ["mosaic", "rollout", "activation", "trial"]),
    edges: [decided("product-long-root", "product-long-answer")],
    authoritativeIds: ["product-long-answer"], acceptableRootIds: ["product-long-root"], candidateAvailable: true,
  },
  {
    split: "holdout", domain: "product", failureShape: "weak-generic-neighbor",
    query: "catalog review status roadmap planning update summary notes archive trace", intent: "direct",
    candidates: holdoutWeakCandidates("product-weak", "product-weak-direct-answer", "product-weak-root", "product-weak-neighbor", "Catalog review overview.", 3, 0.46),
    edges: [
      { sourceId: "product-weak-neighbor", targetId: "product-weak-root", type: "relates_to", weight: 0.27, provenance: "explicit" },
      { sourceId: "product-weak-root", targetId: "product-weak-tail-2", type: "supersedes", weight: 0.22, provenance: "system" },
    ],
    authoritativeIds: ["product-weak-direct-answer"], acceptableRootIds: ["product-weak-root"], candidateAvailable: true,
  },
  {
    split: "development", domain: "product", failureShape: "absent-cluster-control",
    query: "current pricing experiment outcome", intent: "current",
    candidates: absentCandidates("product-absent", "product-absent-answer"), edges: [],
    authoritativeIds: ["product-absent-answer"], acceptableRootIds: [], candidateAvailable: false,
  },

  {
    split: "holdout", domain: "architecture", failureShape: "crowded-lexical-root",
    query: "reason quartz invalidation ownership switched", intent: "causal",
    candidates: holdoutCrowdedCandidates("architecture-crowded", "architecture-crowded-root", "architecture-crowded-answer", "quartz invalidation ownership", "Quartz invalidation ownership switched because one writer had to serialize updates.", "quartz invalidation", 7, 7, 8, 0.61),
    edges: [
      { sourceId: "architecture-crowded-root", targetId: "architecture-crowded-answer", type: "supersedes", weight: 0.72, provenance: "inferred" },
      { sourceId: "architecture-crowded-root", targetId: "architecture-crowded-edge-decoy", type: "follows", weight: 0.39, provenance: "system" },
    ],
    authoritativeIds: ["architecture-crowded-answer"], acceptableRootIds: ["architecture-crowded-root"], candidateAvailable: true,
  },
  {
    split: "development", domain: "architecture", failureShape: "popular-broad-summary",
    query: "current delta indexing approach", intent: "current",
    candidates: popularityCandidates("architecture-popular", "architecture-popular-root", "architecture-popular-summary", "architecture-popular-answer", "The current delta indexing approach writes one normalized projection.", "delta indexing approach"),
    edges: [decided("architecture-popular-root", "architecture-popular-answer")],
    authoritativeIds: ["architecture-popular-answer"], acceptableRootIds: ["architecture-popular-root"], candidateAvailable: true,
  },
  {
    split: "holdout", domain: "architecture", failureShape: "long-parent-pollution",
    query: "lattice restore migration checksum", intent: "direct",
    candidates: holdoutLongCandidates("architecture-long", "architecture-long-root", "architecture-long-answer", ["lattice", "restore", "migration", "checksum"], 7, 1),
    edges: [
      { sourceId: "architecture-long-answer", targetId: "architecture-long-root", type: "supersedes", weight: 0.78, provenance: "inferred" },
      { sourceId: "architecture-long-root", targetId: "architecture-long-edge-decoy", type: "relates_to", weight: 0.26, provenance: "system" },
    ],
    authoritativeIds: ["architecture-long-answer"], acceptableRootIds: ["architecture-long-root"], candidateAvailable: true,
  },
  {
    split: "development", domain: "architecture", failureShape: "weak-generic-neighbor",
    query: "platform architecture status planning update summary review", intent: "direct",
    candidates: weakNeighborCandidates("architecture-weak", "architecture-weak-direct-answer", "architecture-weak-root", "architecture-weak-neighbor", "Platform architecture overview."),
    edges: [weak("architecture-weak-root", "architecture-weak-neighbor")],
    authoritativeIds: ["architecture-weak-direct-answer"], acceptableRootIds: ["architecture-weak-root"], candidateAvailable: true,
  },
  {
    split: "holdout", domain: "architecture", failureShape: "absent-cluster-control",
    query: "what became of horizon message ordering after retry redesign", intent: "chronology",
    candidates: holdoutAbsentCandidates("architecture-absent", "architecture-absent-answer", 8),
    edges: [{ sourceId: "architecture-absent-direct-2", targetId: "architecture-absent-direct-5", type: "decided", weight: 0.44, provenance: "inferred" }],
    authoritativeIds: ["architecture-absent-answer"], acceptableRootIds: [], candidateAvailable: false,
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

deepFreeze(ROOT_QUALITY_CASES);
