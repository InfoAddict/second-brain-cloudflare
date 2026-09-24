export const QUERY_CATEGORIES = [
  "identifier", "cjk", "rare-word", "common-word", "short-word", "paraphrase", "multi-hop", "long-context",
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

/** Canonical identity of a producer for equality checks; undefined (unknown or hash smoke) has its own key. */
export const producerKey = (p: EmbeddingProducer | undefined): string =>
  p ? [p.kind, p.library, p.libraryVersion, p.onnxRuntime, p.repo, p.revision, p.dtype].join("|") : "none";

export interface VariantReport {
  schema: 1;
  variant: string;
  corpus: string;
  embeddingModel: string;
  /** What produced the vectors behind this run; absent for hash-embedding smoke runs. */
  embeddingProducer?: EmbeddingProducer;
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

/** Bump when what a report means changes (measurement, guards, degradation flags, schema). 2: limit and dataFingerprint. 3: embeddingProducer. */
export const RUNNER_VERSION = 3;
