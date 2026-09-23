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
  /** Estimated from the AI call log and NEURON_RATES; replayed calls still count. */
  neurons: number;
  wallMs: number;
}

export interface QueryResult {
  queryId: string;
  category: QueryCategory;
  clusterKey: string;
  rankedIds: string[];
  metrics: QueryMetrics;
  cost: CostSample;
  /** Returned ids whose workspace the viewer cannot read. Must always be empty. */
  leaked: string[];
  ftsRoute?: string;
  error?: string;
}

export interface VariantReport {
  schema: 1;
  variant: string;
  corpus: string;
  embeddingModel: string;
  d1Backend: "sqlite" | "workerd";
  isolate: "warm" | "cold";
  results: QueryResult[];
}
