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

/** Every result in one group, known-gap queries included (cost and hard invariants span the whole run). */
export const summarizeAll = (results: readonly QueryResult[]): Summary => summarizeGroup(results);

function summarizeGroup(results: readonly QueryResult[]): Summary {
  const rows = results.map(r => r.cost.d1RowsRead);
  return {
    n: results.length,
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
  /** Every query, the same population the gate scores. */
  overall: Summary;
  byCategory: Partial<Record<QueryCategory, Summary>>;
  /** Breakdown of the known-gap queries by gap id (they are also counted in overall and byCategory). */
  knownGaps: { overall: Summary | null; byGap: Record<string, Summary> };
  /** The same view without known-gap queries; null when the report has none. Categories without gap queries are omitted. */
  excludingGaps: { overall: Summary; byCategory: Partial<Record<QueryCategory, Summary>> } | null;
}

export function summarize(results: readonly QueryResult[]): ReportSummary {
  const gaps = results.filter(r => gapKey(r.tags) !== null);
  const rest = results.filter(r => gapKey(r.tags) === null);
  const byCategory: Partial<Record<QueryCategory, Summary>> = {};
  for (const category of new Set(results.map(r => r.category))) {
    byCategory[category] = summarizeGroup(results.filter(r => r.category === category));
  }
  const byGap: Record<string, Summary> = {};
  for (const key of [...new Set(gaps.map(r => gapKey(r.tags)!))].sort()) {
    byGap[key] = summarizeGroup(gaps.filter(r => gapKey(r.tags) === key));
  }
  const excluded: Partial<Record<QueryCategory, Summary>> = {};
  for (const category of new Set(gaps.map(r => r.category))) {
    const inCategory = rest.filter(r => r.category === category);
    if (inCategory.length) excluded[category] = summarizeGroup(inCategory);
  }
  return {
    overall: summarizeGroup(results),
    byCategory,
    knownGaps: { overall: gaps.length ? summarizeGroup(gaps) : null, byGap },
    excludingGaps: gaps.length ? { overall: summarizeGroup(rest), byCategory: excluded } : null,
  };
}
