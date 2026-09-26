export const QUERY_CATEGORIES = [
  "identifier", "cjk", "rare-word", "common-word", "short-word", "paraphrase", "multi-hop", "long-context", "agent-framed",
] as const;
export type QueryCategory = (typeof QUERY_CATEGORIES)[number];
export type ViewerId = "avery" | "blake" | "outsider";

export const METRIC_NAMES = ["recall5", "recall10", "mrr10", "ndcg10"] as const;
export type MetricName = (typeof METRIC_NAMES)[number];
export type QueryMetrics = Record<MetricName, number>;

/** grade 2 answers the query directly; grade 1 is supporting evidence. */
export interface GoldRef { id: string; grade: 1 | 2 }

export interface GoldenQuery {
  id: string;
  category: QueryCategory;
  text: string;
  gold: GoldRef[];
  viewer: ViewerId;
  layer?: "personal" | "company";
  /** Graph hops for this query; absent means the config default (0). */
  hops?: number;
  /** Queries sharing a cluster key resample together in the bootstrap. Defaults to the query id. */
  clusterKey?: string;
  tags?: string[];
  /** Audit only: the substring of the gold memory that answers the query (long-context queries). */
  answerSpan?: string;
}

export interface CostSample {
  d1Statements: number;
  /** null on the sqlite backend: node:sqlite cannot report D1's billed rows_read. */
  d1RowsRead: number | null;
  aiCalls: number;
  embeddingCalls: number;
  vectorizeQueries: number;
  kvReads: number;
  /** Provider usage when available, otherwise a labeled estimate; replayed calls still count. */
  neurons: number;
  /** True if any call contributing to neurons lacked provider token usage. */
  neuronsEstimated: boolean;
  wallMs: number;
}

/**
 * Candidate-pool diagnostic (never gated): the fused, reranked candidate list before diversification and truncation.
 * A reranker can only reorder what is in the pool, so recall@30 minus recall@10 is its headroom on a query.
 */
export interface PoolDiagnostic {
  /** Distinct parent ids in the pool. */
  size: number;
  /** Any grade-2 gold anywhere in the pool. */
  goldInPool: boolean;
  /** recall@30 over the pool in score order. */
  recall30: number;
}

export interface QueryResult {
  queryId: string;
  category: QueryCategory;
  clusterKey: string;
  /** The query's tags, so reports can split known-gap queries from the headline without the corpus. */
  tags?: string[];
  rankedIds: string[];
  metrics: QueryMetrics;
  cost: CostSample;
  /** Returned ids whose workspace the viewer cannot read. Must always be empty. */
  leaked: string[];
  ftsRoute?: string;
  /** What the cross-encoder step did for this query (see RecallDiagnostics.rerankRoute). */
  rerankRoute?: string;
  /** Whether any gold id was among the keyword arm's candidates (absent when the arm did not run). A diagnostic for router changes: fusion can bury a gold the arm retrieved, so this isolates candidate coverage. Never gated. */
  keywordGold?: boolean;
  /** Absent on a run that errored and on reports before runner version 8. */
  pool?: PoolDiagnostic;
  /** Degradation recall reported for this query (dense arm down, filter rejected, FTS error). Any entry is a hard-invariant problem. */
  degraded?: string[];
  error?: string;
}

/** Who produced the embeddings a cache holds. Vectors from different producers are never comparable, even for the same model id. */
export interface EmbeddingProducer {
  kind: "local-transformers-js";
  library: string;
  libraryVersion: string;
  onnxRuntime: string;
  /** Hugging Face repo and exact commit the ONNX weights came from. */
  repo: string;
  revision: string;
  dtype: "fp32";
}

/** Models a variant may add on top of the baseline's (a reranker); the gate does not read their one-sided presence as a provenance mismatch. */
export const VARIANT_ADDED_MODELS: readonly string[] = ["@cf/baai/bge-reranker-base"];

/** Canonical identity of a producer for equality checks; undefined (unknown or hash smoke) has its own key. */
export const producerKey = (p: EmbeddingProducer | undefined): string =>
  p ? [p.kind, p.library, p.libraryVersion, p.onnxRuntime, p.repo, p.revision, p.dtype].join("|") : "none";

/** Canonical identity of a whole producer map: every model, sorted. A model present on one side only makes the keys differ. */
export const producersKey = (m: Record<string, EmbeddingProducer> | undefined): string =>
  Object.entries(m ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([model, p]) => `${model}=${producerKey(p)}`).join(";") || "none";

/**
 * Where a report's neuron figures come from. "projected": local tokenizer-exact token counts times the published
 * Workers AI rates, not a billed count (which is why neuronsEstimated can be false: the token counts are exact,
 * only the rate application is a projection). "provider": usage reported by the provider that served the call.
 */
export type NeuronSource = "projected" | "provider";

export interface VariantReport {
  schema: 1;
  variant: string;
  corpus: string;
  embeddingModel: string;
  /** Who produced the outputs of every model this run called (embedding, reranker, ...), keyed by model id. Absent for hash smoke runs. */
  producers?: Record<string, EmbeddingProducer>;
  /** How the neuron figures were obtained; reports with different sources are not comparable on cost. */
  neuronSource?: NeuronSource;
  /** What answered the query-tag LLM call; reports with different arms are not comparable. */
  llmTags?: "stand-in" | "empty";
  d1Backend: "sqlite" | "workerd";
  isolate: "warm" | "cold";
  /** Result depth every query ran at; reports at different depths are not comparable. */
  topK: number;
  /** Bumped when the runner's measurement semantics change or the report schema gains fields. */
  runnerVersion: number;
  /** sha256 of each golden-data file the corpus was built from; reports over different data are not comparable. */
  dataFingerprint?: Record<string, string>;
  /** Set when the run covered only the first N queries; such a report is never gate-eligible. */
  limit?: number;
  results: QueryResult[];
}

/** Bump when what a report means changes (measurement, guards, degradation flags, schema). 2: limit and dataFingerprint. 3: embeddingProducer. 4: producers map (every model) and neuronSource. 6: neuronSource from actual calls and per-row provenance, plus the llmTags arm (query-tag LLM calls answered by a priced embedding stand-in by default). 7: recall diagnostics count first() statements (run as all()), so workerd rows_read is no longer null for queries that ran one. 8: each result carries the candidate-pool diagnostic (pool). */
export const RUNNER_VERSION = 8;
