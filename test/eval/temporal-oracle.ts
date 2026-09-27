import type { CorpusEntry, CorpusSpec } from "./corpus/types";
import { EVAL_NOW } from "./corpus/types";
import { scoreQuery } from "./metrics";
import type { GoldenQuery, QueryMetrics, VariantReport } from "./types";

/** True when the document's declared validity covers instant t (validFrom defaults to createdAt; a retraction ends validity). */
export function validAt(e: CorpusEntry, t: number): boolean {
  const from = e.validFrom ?? e.createdAt;
  const until = Math.min(e.validUntil ?? Infinity, e.retractedAt ?? Infinity);
  return from <= t && t < until;
}

const questionTime = (q: GoldenQuery) => q.asOf ?? q.expectedAsOf ?? EVAL_NOW;

export type OracleKind = "supersession" | "recency";

/**
 * Simulates what Track 2 could at best do to a recorded ranking. "supersession" drops every document whose declared validity
 * excludes the question date. "recency" only reorders the top ranks newest-created first, the shortcut a plain recency boost
 * takes. Neither reads anything but the report and the spec, so they cost no recall and stay offline.
 */
export function simulate(kind: OracleKind, ranked: readonly string[], q: GoldenQuery, byId: ReadonlyMap<string, CorpusEntry>): string[] {
  if (kind === "supersession") return ranked.filter(id => { const e = byId.get(id); return !e || validAt(e, questionTime(q)); });
  return [...ranked].sort((a, b) => (byId.get(b)?.createdAt ?? 0) - (byId.get(a)?.createdAt ?? 0));
}

export interface OracleRow { scope: string; n: number; baseline: QueryMetrics; supersession: QueryMetrics; recency: QueryMetrics }

const meanMetrics = (rows: QueryMetrics[]): QueryMetrics => {
  const avg = (k: keyof QueryMetrics) => (rows.length ? rows.reduce((s, r) => s + r[k], 0) / rows.length : 0);
  return { recall5: avg("recall5"), recall10: avg("recall10"), mrr10: avg("mrr10"), ndcg10: avg("ndcg10") };
};

/** Baseline, supersession-applied and recency-only metrics per category and per subset tag, from the report's own rankings. */
export function oracleTable(report: VariantReport, spec: CorpusSpec): OracleRow[] {
  const byId = new Map(spec.entries.map(e => [e.id, e] as const));
  const queries = new Map(spec.queries.map(q => [q.id, q] as const));
  const scopes = new Map<string, { base: QueryMetrics[]; sup: QueryMetrics[]; rec: QueryMetrics[] }>();
  const add = (scope: string, base: QueryMetrics, sup: QueryMetrics, rec: QueryMetrics) => {
    const row = scopes.get(scope) ?? { base: [], sup: [], rec: [] };
    row.base.push(base); row.sup.push(sup); row.rec.push(rec);
    scopes.set(scope, row);
  };
  for (const r of report.results) {
    const q = queries.get(r.queryId);
    if (!q) continue;
    const base = scoreQuery(r.rankedIds, q.gold);
    const sup = scoreQuery(simulate("supersession", r.rankedIds, q, byId), q.gold);
    const rec = scoreQuery(simulate("recency", r.rankedIds, q, byId), q.gold);
    for (const scope of [q.category, ...(q.tags ?? []).filter(t => t.startsWith("subset:")).map(t => `${q.category} ${t}`)]) add(scope, base, sup, rec);
  }
  return [...scopes].sort(([a], [b]) => a.localeCompare(b)).map(([scope, v]) => ({ scope, n: v.base.length, baseline: meanMetrics(v.base), supersession: meanMetrics(v.sup), recency: meanMetrics(v.rec) }));
}
