import { mean, percentile } from "./metrics";
import { pairedBootstrap, type BootstrapCI } from "./stats";
import { METRIC_NAMES, QUERY_CATEGORIES, type MetricName, type QueryCategory, type QueryResult, type VariantReport } from "./types";

export interface GateThresholds {
  headlineTolerance: number;
  categoryToleranceFloor: number;
  minCategoryQueries: number;
  improvementMargin: number;
  targetMargin: number;
  minQueries: number;
  minClusters: number;
  minCategoryClusters: number;
  maxAddedD1Statements: number;
  d1StatementCeiling: number;
  rowsReadRatio: number;
  rowsReadSlack: number;
  maxAddedNeuronsPerRecall: number;
  maxAddedAiCalls: number;
}

// Provisional: Rahil approves; Task 11 checks them against the measured MDE.
export const DEFAULT_GATE: Readonly<GateThresholds> = Object.freeze({
  headlineTolerance: 0.01,
  categoryToleranceFloor: 0.03,
  minCategoryQueries: 10,
  improvementMargin: 0.02,
  targetMargin: 0.05,
  minQueries: 200,
  // Provisional: 4 clusters x 50 queries covered only 78.5% of a nominal 95% interval; Task 11 calibrates this.
  minClusters: 30,
  // Provisional: distinct clusters a category needs before its interval can prove a targeted gain; Task 11 calibrates.
  minCategoryClusters: 10,
  maxAddedD1Statements: 2,
  d1StatementCeiling: 50,
  rowsReadRatio: 1.25,
  rowsReadSlack: 50,
  maxAddedNeuronsPerRecall: 25,
  maxAddedAiCalls: 1,
});

export type RuleStatus = "pass" | "fail" | "inconclusive" | "skipped";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";
export interface RuleResult { rule: string; status: RuleStatus; detail: string }
export interface MetricDelta { scope: string; metric: MetricName; base: number; candidate: number; ci: BootstrapCI }
export interface GateResult { verdict: Verdict; rules: RuleResult[]; deltas: MetricDelta[] }
export interface GateOptions {
  thresholds?: Partial<GateThresholds>;
  /** Categories the variant claims to help; enables the targeted-gain path. */
  targetCategories?: readonly QueryCategory[];
  allowUnmeasuredRowsRead?: boolean;
}

interface Pair { b: QueryResult; c: QueryResult }

function finish(rules: RuleResult[], deltas: MetricDelta[]): GateResult {
  const verdict: Verdict = rules.some(r => r.status === "fail") ? "FAIL"
    : rules.some(r => r.status === "inconclusive") ? "INCONCLUSIVE" : "PASS";
  return { verdict, rules, deltas };
}

const listIds = (ids: string[]) => ids.length > 5 ? `${ids.slice(0, 5).join(", ")} (+${ids.length - 5} more)` : ids.join(", ");

function duplicateIds(r: VariantReport): string[] {
  const seen = new Set<string>(), dups = new Set<string>();
  for (const q of r.results) (seen.has(q.queryId) ? dups : seen).add(q.queryId);
  return [...dups];
}

function comparabilityProblems(base: VariantReport, cand: VariantReport): string[] {
  const problems: string[] = [];
  if (base.corpus !== cand.corpus) problems.push(`corpus differs (${base.corpus} vs ${cand.corpus})`);
  if (base.embeddingModel !== cand.embeddingModel) problems.push("embedding model differs");
  if (base.d1Backend !== cand.d1Backend) problems.push("D1 backend differs");
  if (base.isolate !== cand.isolate) problems.push("isolate mode differs");
  const baseDups = duplicateIds(base), candDups = duplicateIds(cand);
  if (baseDups.length) problems.push(`duplicate query IDs in baseline: ${listIds(baseDups)}`);
  if (candDups.length) problems.push(`duplicate query IDs in candidate: ${listIds(candDups)}`);
  if (baseDups.length || candDups.length) return problems;

  const baseById = new Map(base.results.map(r => [r.queryId, r] as const));
  const candById = new Map(cand.results.map(r => [r.queryId, r] as const));
  const onlyBase = [...baseById.keys()].filter(id => !candById.has(id));
  const onlyCand = [...candById.keys()].filter(id => !baseById.has(id));
  if (onlyBase.length || onlyCand.length) {
    problems.push(`query sets differ (only in baseline: ${listIds(onlyBase) || "none"}; only in candidate: ${listIds(onlyCand) || "none"})`);
    return problems;
  }
  const badCategory = [...baseById].filter(([id, b]) => b.category !== candById.get(id)!.category).map(([id]) => id);
  const badCluster = [...baseById].filter(([id, b]) => b.clusterKey !== candById.get(id)!.clusterKey).map(([id]) => id);
  if (badCategory.length) problems.push(`category differs between reports for: ${listIds(badCategory)}`);
  if (badCluster.length) problems.push(`clusterKey differs between reports for: ${listIds(badCluster)}`);
  return problems;
}

export function evaluateGate(base: VariantReport, cand: VariantReport, opts: GateOptions = {}): GateResult {
  const t = { ...DEFAULT_GATE, ...opts.thresholds };
  const rules: RuleResult[] = [];
  const deltas: MetricDelta[] = [];
  const add = (rule: string, status: RuleStatus, detail: string) => rules.push({ rule, status, detail });

  // Hard invariants come first: a violation is a FAIL however small or incomparable the sample.
  const leaks = cand.results.reduce((s, r) => s + r.leaked.length, 0);
  add("isolation", leaks === 0 ? "pass" : "fail", `${leaks} cross-workspace result(s)`);
  const baseErrors = base.results.filter(r => r.error).length;
  const candErrors = cand.results.filter(r => r.error).length;
  add("errors", candErrors <= baseErrors ? "pass" : "fail", `${candErrors} query error(s) vs ${baseErrors} in the baseline`);

  const problems = comparabilityProblems(base, cand);
  if (problems.length) {
    add("comparable", "inconclusive", problems.join("; "));
    return finish(rules, deltas);
  }
  const baseById = new Map(base.results.map(r => [r.queryId, r] as const));
  // IDs are unique and labels identical (validated above), so the shared keys are safe to resample on.
  const pairs: Pair[] = cand.results.map(c => ({ b: baseById.get(c.queryId)!, c }));
  if (pairs.length < t.minQueries) {
    add("power", "inconclusive", `${pairs.length} queries is below the ${t.minQueries}-query floor`);
    return finish(rules, deltas);
  }
  const clusters = new Set(pairs.map(p => p.c.clusterKey)).size;
  if (clusters < t.minClusters) {
    add("power", "inconclusive", `${clusters} distinct clusters is below the ${t.minClusters}-cluster floor`);
    return finish(rules, deltas);
  }

  const delta = (scope: string, subset: Pair[], metric: MetricName): MetricDelta => {
    const d = subset.map(p => p.c.metrics[metric] - p.b.metrics[metric]);
    const ci = pairedBootstrap(d, subset.map(p => p.c.clusterKey));
    const row = { scope, metric, base: mean(subset.map(p => p.b.metrics[metric])), candidate: mean(subset.map(p => p.c.metrics[metric])), ci };
    deltas.push(row);
    return row;
  };

  // No regression: point estimate at or past the tolerance, or a significant drop of any size.
  const regressions: string[] = [];
  for (const metric of METRIC_NAMES) {
    const row = delta("overall", pairs, metric);
    if (row.ci.mean <= -t.headlineTolerance || row.ci.hi < 0) regressions.push(`overall ${metric} ${row.ci.mean.toFixed(4)}`);
  }
  const skipped: string[] = [];
  for (const category of QUERY_CATEGORIES) {
    const subset = pairs.filter(p => p.c.category === category);
    if (subset.length < t.minCategoryQueries) {
      if (subset.length) skipped.push(`${category} (n=${subset.length})`);
      continue;
    }
    const tolerance = Math.max(t.categoryToleranceFloor, 1 / subset.length);
    for (const metric of ["recall10", "mrr10"] as const) {
      const row = delta(category, subset, metric);
      if (row.ci.mean <= -tolerance || row.ci.hi < 0) regressions.push(`${category} ${metric} ${row.ci.mean.toFixed(4)}`);
    }
  }
  add("regression", regressions.length ? "fail" : "pass",
    regressions.length ? regressions.join("; ") : `no headline or category regression${skipped.length ? `; skipped underpowered: ${skipped.join(", ")}` : ""}`);

  // Improvement: proven gain overall, or a proven targeted gain in a declared category.
  const wins: string[] = [];
  for (const metric of ["recall10", "mrr10", "ndcg10"] as const) {
    const row = deltas.find(d => d.scope === "overall" && d.metric === metric)!;
    if (row.ci.mean >= t.improvementMargin && row.ci.lo > 0) wins.push(`overall ${metric} +${row.ci.mean.toFixed(4)}`);
  }
  const underpowered: string[] = [];
  for (const category of opts.targetCategories ?? []) {
    const subset = pairs.filter(p => p.c.category === category);
    if (subset.length < t.minCategoryQueries) continue;
    const clusters = new Set(subset.map(p => p.c.clusterKey)).size;
    const powered = clusters >= t.minCategoryClusters;
    for (const metric of ["recall10", "mrr10"] as const) {
      const row = delta(`${category} (target)`, subset, metric);
      if (!(row.ci.mean >= t.targetMargin && row.ci.lo > 0)) continue;
      if (powered) wins.push(`${category} ${metric} +${row.ci.mean.toFixed(4)}`);
      else underpowered.push(`${category} ${metric} +${row.ci.mean.toFixed(4)} has ${clusters} cluster${clusters === 1 ? "" : "s"}, below the ${t.minCategoryClusters}-cluster floor`);
    }
  }
  if (wins.length) add("improvement", "pass", wins.join("; "));
  else if (underpowered.length) add("improvement", "inconclusive", `targeted gain cannot be proven: ${underpowered.join("; ")}`);
  else add("improvement", "fail", `no metric improved by ${t.improvementMargin} (or ${t.targetMargin} in a target category) with a bootstrap lower bound above zero`);

  // Cost budget.
  const costs = (r: VariantReport) => r.results.map(x => x.cost);
  const bc = costs(base), cc = costs(cand);
  const problemsCost: string[] = [];
  const stmtMean = mean(cc.map(c => c.d1Statements)), stmtBase = mean(bc.map(c => c.d1Statements));
  if (stmtMean > stmtBase + t.maxAddedD1Statements) problemsCost.push(`D1 statements mean ${stmtMean.toFixed(2)} vs ${stmtBase.toFixed(2)}`);
  const stmtP95 = percentile(cc.map(c => c.d1Statements), 95);
  if (stmtP95 > t.d1StatementCeiling) problemsCost.push(`D1 statements p95 ${stmtP95} exceeds ${t.d1StatementCeiling}`);
  const neuronMean = mean(cc.map(c => c.neurons)), neuronBase = mean(bc.map(c => c.neurons));
  if (neuronMean > neuronBase + t.maxAddedNeuronsPerRecall) problemsCost.push(`neurons mean ${neuronMean.toFixed(1)} vs ${neuronBase.toFixed(1)}`);
  const aiMean = mean(cc.map(c => c.aiCalls)), aiBase = mean(bc.map(c => c.aiCalls));
  if (aiMean > aiBase + t.maxAddedAiCalls) problemsCost.push(`AI calls mean ${aiMean.toFixed(2)} vs ${aiBase.toFixed(2)}`);

  const measured = [...bc, ...cc].every(c => c.d1RowsRead !== null);
  let rowsNote = "";
  if (measured) {
    const rows = (cs: typeof bc) => cs.map(c => c.d1RowsRead as number);
    const limitMean = mean(rows(bc)) * t.rowsReadRatio + t.rowsReadSlack;
    const limitP95 = percentile(rows(bc), 95) * t.rowsReadRatio + t.rowsReadSlack;
    if (mean(rows(cc)) > limitMean) problemsCost.push(`rows_read mean ${mean(rows(cc)).toFixed(0)} exceeds ${limitMean.toFixed(0)}`);
    if (percentile(rows(cc), 95) > limitP95) problemsCost.push(`rows_read p95 ${percentile(rows(cc), 95)} exceeds ${limitP95.toFixed(0)}`);
    rowsNote = "; rows_read measured";
  } else if (opts.allowUnmeasuredRowsRead) {
    rowsNote = "; rows_read unmeasured (allowed)";
  } else {
    add("cost", problemsCost.length ? "fail" : "inconclusive",
      problemsCost.length ? problemsCost.join("; ") : "rows_read unmeasured: rerun with --d1 workerd or pass --allow-unmeasured-rows");
    return finish(rules, deltas);
  }
  add("cost", problemsCost.length ? "fail" : "pass", problemsCost.length ? problemsCost.join("; ") : `within budget${rowsNote}`);
  return finish(rules, deltas);
}

export function formatGate(result: GateResult): string {
  const lines = [`GATE: ${result.verdict}`];
  for (const r of result.rules) lines.push(`  [${r.status.toUpperCase().padEnd(12)}] ${r.rule}: ${r.detail}`);
  lines.push("  deltas (candidate - baseline, 95% bootstrap CI):");
  for (const d of result.deltas) {
    lines.push(`    ${d.scope.padEnd(24)} ${d.metric.padEnd(8)} ${d.base.toFixed(3)} -> ${d.candidate.toFixed(3)}  ${d.ci.mean >= 0 ? "+" : ""}${d.ci.mean.toFixed(4)}  [${d.ci.lo.toFixed(4)}, ${d.ci.hi.toFixed(4)}]`);
  }
  return lines.join("\n");
}
