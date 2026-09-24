import type { EdgeProvenance, EdgeType } from "../graph/types";
import type { Identity } from "../lib/identity";
import type { EmbeddingQueryMode } from "./query-profile";
import type { RootView } from "./root-selector";

export interface CompoundStaleSignal {
  count: number;
  oldestUpdatedAt: number;
}

export interface RecallMatch {
  id: string;
  content: string;
  score: number;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  source: string;
  isUpdate: boolean;
  hop: number;
  staleAsOf?: boolean;
  /** Which layer this memory lives in, so clients can show or act on it. */
  workspace?: "personal" | "company" | "system";
  /** Resolved author label on company-layer matches (shared memories). */
  actorName?: string;
  // Set only on graph-expanded matches (hop > 0): why / when / whence the edge that surfaced this memory.
  viaProvenance?: EdgeProvenance; // "explicit" (you linked) / "inferred" (auto) / "system"
  viaType?: EdgeType;
  viaLinkedAt?: number;           // when the edge was formed
  viaFrom?: string;               // id of the memory this one was reached from
}

export interface RecallSearchResult {
  matches: RecallMatch[];
  insight: string;
  semanticUnavailable: boolean;
  queryUsed?: string;
  // Distilled query terms, reused to pick a query-relevant excerpt when a long
  // memory has to be shortened for the response.
  queryTokens?: string[];
  compoundStale?: CompoundStaleSignal;
}

export interface RecallDiagnostics {
  embeddingMode?: EmbeddingQueryMode;
  denseIds?: string[];
  keywordIds?: string[];
  candidateIds?: string[];
  fusedIds?: string[];
  rootSelections?: { id: string; selectedBy: RootView }[];
  expandedIds?: string[];
  eligibleRelatedIds?: string[];
  selectedRelatedIds?: string[];
  finalIds?: string[];
  rejections?: { id: string; reason: string }[];
  operations?: RecallOperationDiagnostics;
  /** Observation anomalies, e.g. a first() statement that returned more than one row. Absent when there are none. */
  warnings?: string[];
  stageMs?: Partial<Record<RecallStage, number>>;
  /** #326 visibility: how many tokens reached keywordSearch, and whether it was skipped for want of any. */
  retrievalTokenCount?: number;
  lexicalArmSkipped?: boolean;
  /** Whether fusion could use corpus-wide DF for every lexical token (false = fetch-window estimate). */
  corpusIdfUsed?: boolean;
  /** Whether the FTS5 path served the keyword rows (false = LIKE, including any degrade-on-error). */
  ftsUsed?: boolean;
  /** Why the keyword arm served FTS or LIKE on the last recall; memberFirst recalls never reach keywordSearch. */
  ftsRoute?: "fts" | "fts-bounded" | "like-not-ready" | "like-ineligible-token" | "like-match-budget" | "like-error" | "like-member-first" | "skipped-by-variant";
  /** T-0059: how df/total were obtained on the last recall's term distillation. */
  distillSource?: "fts" | "like" | "shortcut";
  /** What the cross-encoder step did on the last recall; "applied" means one model call reordered the candidates. */
  rerankRoute?: RerankRoute;
  /** Set when single-term keyword evidence was withheld: the term is too common (df over the saturation fraction, or the keyword window filled) or the corpus size was unavailable. */
  rerankEvidence?: "suppressed-saturated" | "suppressed-no-total";
  /** Wall time of the model call, when one was made. */
  rerankMs?: number;
}

export type RerankRoute = "off" | "not-ready" | "too-few" | "exact-id" | "clear-leader" | "attempted" | "applied" | "error" | "timeout";

export type RecallStage = "setup" | "querySignals" | "candidateGeneration" | "candidateHydration"
  | "graphExpansion" | "finalHydration" | "selection" | "synthesis" | "total";

export interface RecallOperationDiagnostics {
  aiCalls: number;
  embeddingCalls: number;
  vectorizeQueries: number;
  vectorizeGets: number;
  d1Statements: number;
  d1RowsRead: number | null;
  d1RowsWritten: number | null;
  kvReads: number;
  kvWrites: number;
}

/** Eval-only switches. Future variants add optional fields here; absent means default recall. */
export interface RecallVariantFlags {
  /** Tag and project recalls use both arms regardless of this ablation. */
  arms?: "both" | "dense-only" | "keyword-only";
  /** true forces the reranker on for the run (still subject to tenancy and the exact-identifier skip); no route sets it. */
  rerank?: boolean;
  /** Eval-only overrides of the reranker's blend weight, batch size and excerpt length; absent means the shipped values. */
  rerankTuning?: RerankTuning;
}

export interface RerankTuning { weight?: number; floor?: number; maxCandidates?: number; excerptChars?: number }

export interface RecallInternalOptions {
  embeddingQueryMode?: EmbeddingQueryMode;
  diagnostics?: RecallDiagnostics;
  /**
   * When present, every entries read in the pipeline is scoped to the caller's
   * readable workspaces (personal ∪ company). Absent — internal callers and the
   * pre-tenancy tests — the SQL is exactly what it was before v3.
   */
  identity?: Identity;
  /**
   * Narrows the read to ONE layer of the readable set ("personal" or "company")
   * instead of the union. Only ever narrows: the ids still come from the
   * identity, so this cannot name a workspace the caller does not belong to.
   */
  workspaceFilter?: "personal" | "company";
  /** Narrows reads to one company team workspace (validated at the route edge). */
  teamId?: string;
  /**
   * Test-only escape hatch: forces fuseDenseAndKeyword's keywordPreRanked
   * argument regardless of whether FTS served the rows. No route may set this;
   * it exists so benchmarks can isolate Task 6's fusion-order change from
   * Task 3's candidate-selection change (FTS-ready but bm25 order disabled).
   */
  keywordPreRankedOverride?: boolean;
  /** Eval-only experiment switches; no route or MCP tool sets these. */
  variant?: RecallVariantFlags;
}

export interface KeywordRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
}

export type { VectorizeMatch } from "./math";
