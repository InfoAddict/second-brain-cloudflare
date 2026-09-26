import type { GoldRef, QueryCategory, QueryMetrics, QueryResult } from "./types";

const unique = (ids: readonly string[]) => [...new Set(ids)];

export function recallAtK(ranked: readonly string[], gold: readonly GoldRef[], k: number): number {
  if (!gold.length) return 0;
  const top = new Set(unique(ranked).slice(0, k));
  return gold.filter(g => top.has(g.id)).length / gold.length;
}

export function mrrAtK(ranked: readonly string[], gold: readonly GoldRef[], k: number): number {
  const ids = new Set(gold.map(g => g.id));
  const index = unique(ranked).slice(0, k).findIndex(id => ids.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

const gain = (grade: number) => 2 ** grade - 1;

export function ndcgAtK(ranked: readonly string[], gold: readonly GoldRef[], k: number): number {
  const grade = new Map(gold.map(g => [g.id, g.grade] as const));
  const dcg = unique(ranked).slice(0, k)
    .reduce((sum, id, i) => sum + gain(grade.get(id) ?? 0) / Math.log2(i + 2), 0);
  const ideal = gold.map(g => g.grade).sort((a, b) => b - a).slice(0, k)
    .reduce((sum, g, i) => sum + gain(g) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function scoreQuery(ranked: readonly string[], gold: readonly GoldRef[]): QueryMetrics {
  return {
    recall5: recallAtK(ranked, gold, 5),
    recall10: recallAtK(ranked, gold, 10),
    mrr10: mrrAtK(ranked, gold, 10),
    ndcg10: ndcgAtK(ranked, gold, 10),
  };
}

export const mean = (values: readonly number[]) =>
  values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;

/** Nearest-rank percentile, p in (0, 100]. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export interface Dist { mean: number; p50: number; p95: number }
const dist = (values: readonly number[]): Dist => ({ mean: mean(values), p50: percentile(values, 50), p95: percentile(values, 95) });

export interface Summary {
  n: number;
  metrics: QueryMetrics;
  /** Candidate-pool diagnostic means (not gated); absent when no result carries one. */
  pool?: { goldInPool: number; recall30: number };
  d1Statements: Dist;
  d1RowsRead: Dist | null;
  aiCalls: Dist;
  neurons: Dist;
  estimatedNeuronQueries: number;
  wallMs: Dist;
  leaks: number;
  errors: number;
  degraded: number;
}

function summarizeGroup(results: readonly QueryResult[]): Summary {
  const rows = results.map(r => r.cost.d1RowsRead);
  const pooled = results.filter(r => r.pool);
  return {
    n: results.length,
    ...(pooled.length && { pool: { goldInPool: mean(pooled.map(r => (r.pool!.goldInPool ? 1 : 0))), recall30: mean(pooled.map(r => r.pool!.recall30)) } }),
    metrics: {
      recall5: mean(results.map(r => r.metrics.recall5)),
      recall10: mean(results.map(r => r.metrics.recall10)),
      mrr10: mean(results.map(r => r.metrics.mrr10)),
      ndcg10: mean(results.map(r => r.metrics.ndcg10)),
    },
    d1Statements: dist(results.map(r => r.cost.d1Statements)),
    d1RowsRead: rows.length && rows.every((v): v is number => v !== null) ? dist(rows) : null,
    aiCalls: dist(results.map(r => r.cost.aiCalls)),
    neurons: dist(results.map(r => r.cost.neurons)),
    estimatedNeuronQueries: results.filter(r => r.cost.neuronsEstimated).length,
    wallMs: dist(results.map(r => r.cost.wallMs)),
    leaks: results.reduce((s, r) => s + r.leaked.length, 0),
    errors: results.filter(r => r.error).length,
    degraded: results.filter(r => r.degraded?.length).length,
  };
}

/** The gap a query is filed under, or null for a headline query: `gap:<id>` wins over a bare `known-gap` tag. */
export function gapKey(tags: readonly string[] | undefined): string | null {
  const gap = tags?.find(t => t.startsWith("gap:"));
  if (gap) return gap;
  return tags?.includes("known-gap") ? "known-gap" : null;
}

export interface ReportSummary {
  /** The gate's population: known-gap queries are excluded and reported in knownGaps. */
  overall: Summary;
  byCategory: Partial<Record<QueryCategory, Summary>>;
  knownGaps: { overall: Summary | null; byGap: Record<string, Summary> };
  /** Every query, gaps included: what cost and the hard invariants cover. */
  allQueries: Summary;
}

export function summarize(results: readonly QueryResult[]): ReportSummary {
  const headline = results.filter(r => gapKey(r.tags) === null);
  const gaps = results.filter(r => gapKey(r.tags) !== null);
  const byCategory: Partial<Record<QueryCategory, Summary>> = {};
  for (const category of new Set(headline.map(r => r.category))) {
    byCategory[category] = summarizeGroup(headline.filter(r => r.category === category));
  }
  const byGap: Record<string, Summary> = {};
  for (const key of [...new Set(gaps.map(r => gapKey(r.tags)!))].sort()) {
    byGap[key] = summarizeGroup(gaps.filter(r => gapKey(r.tags) === key));
  }
  return {
    overall: summarizeGroup(headline),
    byCategory,
    knownGaps: { overall: gaps.length ? summarizeGroup(gaps) : null, byGap },
    allQueries: summarizeGroup(results),
  };
}
