import { gapKey, mean, percentile } from "./metrics";
import { CORPUS_IDS } from "./corpus/build";
import { fingerprintKey } from "./lock";
import { PUBLIC_CORPORA } from "./public/neutral";
import { minimumDetectableEffect, pairedBootstrap, type BootstrapCI } from "./stats";
import { METRIC_NAMES, QUERY_CATEGORIES, RUNNER_VERSION, producersKey, type MetricName, type QueryCategory, type QueryResult, type VariantReport } from "./types";

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
export interface GateResult { verdict: Verdict; rules: RuleResult[]; deltas: MetricDelta[]; mde: Partial<Record<MetricName, number>> }
export interface GateOptions {
  thresholds?: Partial<GateThresholds>;
  /** Categories the variant claims to help; enables the targeted-gain path. */
  targetCategories?: readonly QueryCategory[];
  allowUnmeasuredRowsRead?: boolean;
  /** Known gaps (ids like "T-0072") the variant claims to fix. Their queries rejoin the rules and get their own improvement path. */
  targetGaps?: readonly string[];
}

interface Pair { b: QueryResult; c: QueryResult }

function finish(rules: RuleResult[], deltas: MetricDelta[], mde: GateResult["mde"] = {}): GateResult {
  const verdict: Verdict = rules.some(r => r.status === "fail") ? "FAIL"
    : rules.some(r => r.status === "inconclusive") ? "INCONCLUSIVE" : "PASS";
  return { verdict, rules, deltas, mde };
}

/** Every gap marker on a query, sorted, so a second or swapped gap id is drift too. */
const gapSignature = (tags?: string[]): string => (tags ?? []).filter(t => t === "known-gap" || t.startsWith("gap:")).sort().join("|");

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
  if (producersKey(base.producers) !== producersKey(cand.producers)) problems.push("model producers differ (outputs from different producers, or a model used on one side only, are not comparable)");
  const fingerprinted = (id: string) => (CORPUS_IDS as readonly string[]).includes(id) || Object.hasOwn(PUBLIC_CORPORA, id);
  for (const [label, r] of [["baseline", base], ["candidate", cand]] as const) {
    if (fingerprinted(r.corpus) && !Object.keys(r.producers ?? {}).length) problems.push(`the ${label} report has no verified model producers (unverified provenance); rerun it against a stamped or freshly recorded cache`);
  }
  if ((base.neuronSource ?? "none") !== (cand.neuronSource ?? "none")) problems.push(`neuron source differs (${base.neuronSource ?? "none"} vs ${cand.neuronSource ?? "none"})`);
  if ((base.llmTags ?? "none") !== (cand.llmTags ?? "none")) problems.push(`LLM tag arm differs (${base.llmTags ?? "none"} vs ${cand.llmTags ?? "none"}); the arms answer query-tag inference differently, so rankings and cost are not comparable`);
  if (base.d1Backend !== cand.d1Backend) problems.push("D1 backend differs");
  if (base.isolate !== cand.isolate) problems.push("isolate mode differs");
  if (base.topK !== cand.topK) problems.push(`top-k differs (${base.topK} vs ${cand.topK})`);
  if (base.runnerVersion !== cand.runnerVersion) problems.push(`runner version differs (${base.runnerVersion} vs ${cand.runnerVersion})`);
  for (const [label, r] of [["baseline", base], ["candidate", cand]] as const) {
    if (r.runnerVersion !== RUNNER_VERSION) problems.push(`the ${label} was produced by runner version ${r.runnerVersion}, which is stale (current ${RUNNER_VERSION}); rerun it`);
  }
  if (base.limit !== undefined || cand.limit !== undefined) problems.push(`a report was limited to the first N queries (baseline ${base.limit ?? "full"}, candidate ${cand.limit ?? "full"}); rerun without --limit`);
  if (fingerprinted(base.corpus) || fingerprinted(cand.corpus)) {
    for (const [label, r] of [["baseline", base], ["candidate", cand]] as const) {
      if (!r.dataFingerprint) problems.push(`the ${label} report has no golden-data fingerprint, which core and public corpus reports must carry; rerun it`);
    }
  }
  if (base.dataFingerprint && cand.dataFingerprint && fingerprintKey(base.dataFingerprint) !== fingerprintKey(cand.dataFingerprint)) problems.push("golden data differs (fingerprint mismatch)");
  else if (!base.dataFingerprint !== !cand.dataFingerprint && !problems.some(p => p.includes("fingerprint"))) problems.push("golden-data fingerprint present on only one report");
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
  const badTags = [...baseById].filter(([id, b]) => gapSignature(b.tags) !== gapSignature(candById.get(id)!.tags)).map(([id]) => id);
  if (badTags.length) problems.push(`known-gap tags differ between reports for: ${listIds(badTags)}`);
  if (badCategory.length) problems.push(`category differs between reports for: ${listIds(badCategory)}`);
  if (badCluster.length) problems.push(`clusterKey differs between reports for: ${listIds(badCluster)}`);
  return problems;
}

function unmeasuredRowsRead(base: VariantReport, cand: VariantReport): string {
  if (base.d1Backend !== "workerd" && cand.d1Backend !== "workerd") {
    return "rows_read is unmeasured on the sqlite backend: rerun with --d1 workerd for a full verdict, or pass --allow-unmeasured-rows for a cost-blind comparison";
  }
  const missing = (r: VariantReport) => `${r.results.filter(x => x.cost.d1RowsRead === null).length} of ${r.results.length}`;
  return `${missing(base)} queries in the baseline and ${missing(cand)} in the candidate reported no rows_read on the ${base.d1Backend === "workerd" ? "workerd" : cand.d1Backend} backend (a statement whose result carries no meta); pass --allow-unmeasured-rows for a cost-blind comparison`;
}

export function evaluateGate(base: VariantReport, cand: VariantReport, opts: GateOptions = {}): GateResult {
  const t = { ...DEFAULT_GATE, ...opts.thresholds };
  const rules: RuleResult[] = [];
  const deltas: MetricDelta[] = [];
  const mde: GateResult["mde"] = {};
  const add = (rule: string, status: RuleStatus, detail: string) => rules.push({ rule, status, detail });

  // Hard invariants come first: a violation is a FAIL however small or incomparable the sample.
  const leaks = cand.results.reduce((s, r) => s + r.leaked.length, 0);
  add("isolation", leaks === 0 ? "pass" : "fail", `${leaks} cross-workspace result(s)`);
  const baseErrors = base.results.filter(r => r.error).length;
  const candErrors = cand.results.filter(r => r.error).length;
  // Either side: an errored baseline scores zeros and would flatter any candidate.
  add("errors", candErrors + baseErrors === 0 ? "pass" : "fail", `${candErrors} query error(s) in the candidate, ${baseErrors} in the baseline`);

  // A degraded run measures a broken pipeline: fail closed on either side, so a degraded baseline cannot flatter a candidate.
  const degradedBase = base.results.filter(r => r.degraded?.length).length;
  const degradedCand = cand.results.filter(r => r.degraded?.length).length;
  add("degraded", degradedBase + degradedCand === 0 ? "pass" : "fail", `${degradedCand} degraded query(ies) in the candidate, ${degradedBase} in the baseline`);

  const problems = comparabilityProblems(base, cand);
  if (problems.length) {
    add("comparable", "inconclusive", problems.join("; "));
    return finish(rules, deltas);
  }
  const baseById = new Map(base.results.map(r => [r.queryId, r] as const));
  // IDs are unique and labels identical (validated above), so the shared keys are safe to resample on.
  const allPairs: Pair[] = cand.results.map(c => ({ b: baseById.get(c.queryId)!, c }));
  // Known-gap queries are tagged statically but the gaps are corpus-conditional (corpus/audit.ts): a gap that
  // scores 0 at scale can score 1 at core-1k. So the tag alone decides nothing; the baseline score in THIS report does.
  //  - improvement and target rules see the non-gap queries only, so a gap fix is never averaged into a category or overall delta;
  //  - the regression rule sees every non-gap query plus every gap query the baseline already answers (> 0), independent of any
  //    declaration. A gap query at baseline 0 cannot regress and would only dilute the rule.
  //  - a declared targetGap gets its own separate improvement path below, over exactly its queries.
  // Invariants (leaks, errors, degraded) above and cost below span all queries.
  const isGap = (p: Pair) => gapKey(p.c.tags) !== null;
  const gapIds = (tags?: string[]) => (tags ?? []).filter(t => t.startsWith("gap:")).map(t => t.slice(4));
  const pairs = allPairs.filter(p => !isGap(p));
  const protectedGaps = allPairs.filter(p => isGap(p) && Object.values(p.b.metrics).some(v => v > 0));
  const regressionPairs = [...pairs, ...protectedGaps];
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
    const row = delta("overall", regressionPairs, metric);
    // Same rows the regression rule judges: how small a loss could it have seen.
    mde[metric] = minimumDetectableEffect(regressionPairs.map(p => p.c.metrics[metric] - p.b.metrics[metric]));
    if (row.ci.mean <= -t.headlineTolerance || row.ci.hi < 0) regressions.push(`overall ${metric} ${row.ci.mean.toFixed(4)}`);
  }
  const skipped: string[] = [];
  for (const category of QUERY_CATEGORIES) {
    const subset = regressionPairs.filter(p => p.c.category === category);
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
    // Same rows as the regression rule unless protected gap queries widened its population.
    const row = protectedGaps.length ? delta("overall (non-gap)", pairs, metric) : deltas.find(d => d.scope === "overall" && d.metric === metric)!;
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
  // Declared target gaps: a separate improvement path over exactly those queries, held to the category path's floors.
  // Below them the path is inconclusive whatever the point estimate says, and the verdict detail says why.
  for (const id of opts.targetGaps ?? []) {
    const subset = allPairs.filter(p => gapIds(p.c.tags).includes(id));
    if (!subset.length) { add("target-gaps", "inconclusive", `declared target gap ${id} matches no query`); continue; }
    const gapClusters = new Set(subset.map(p => p.c.clusterKey)).size;
    const powered = subset.length >= t.minCategoryQueries && gapClusters >= t.minCategoryClusters;
    for (const metric of ["recall10", "mrr10"] as const) {
      const row = delta(`gap:${id} (target)`, subset, metric);
      if (!powered) continue;
      if (row.ci.mean >= t.targetMargin && row.ci.lo > 0) wins.push(`gap:${id} ${metric} +${row.ci.mean.toFixed(4)} (n=${subset.length} queries, ${gapClusters} clusters)`);
    }
    if (!powered) {
      underpowered.push(`gap:${id} has ${subset.length} queries in ${gapClusters} clusters, below the ${t.minCategoryQueries}-query / ${t.minCategoryClusters}-cluster floor; a fix cannot be proven at this gate`);
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
      problemsCost.length ? problemsCost.join("; ") : unmeasuredRowsRead(base, cand));
    return finish(rules, deltas, mde);
  }
  add("cost", problemsCost.length ? "fail" : "pass", problemsCost.length ? problemsCost.join("; ") : `within budget${rowsNote}`);
  return finish(rules, deltas, mde);
}

export function formatGate(result: GateResult): string {
  const lines = [`GATE: ${result.verdict}`];
  for (const r of result.rules) lines.push(`  [${r.status.toUpperCase().padEnd(12)}] ${r.rule}: ${r.detail}`);
  const mdeText = Object.entries(result.mde).map(([m, v]) => `${m} ${v!.toFixed(4)}`).join("  ");
  if (mdeText) lines.push(`  minimum detectable effect (80% power): ${mdeText}`);
  lines.push("  deltas (candidate - baseline, 95% bootstrap CI):");
  for (const d of result.deltas) {
    lines.push(`    ${d.scope.padEnd(24)} ${d.metric.padEnd(8)} ${d.base.toFixed(3)} -> ${d.candidate.toFixed(3)}  ${d.ci.mean >= 0 ? "+" : ""}${d.ci.mean.toFixed(4)}  [${d.ci.lo.toFixed(4)}, ${d.ci.hi.toFixed(4)}]`);
  }
  return lines.join("\n");
}

export interface Loser { queryId: string; category: QueryCategory; base: QueryResult["metrics"]; candidate: QueryResult["metrics"]; drop: number }

/**
 * Queries whose score or rank worsened on any headline metric (MRR falls when the first hit ranks lower), worst
 * first. Not part of the verdict: category means can hide a few losers behind a few larger winners. Aligns by
 * queryId and skips queries on one side only (comparability is the gate's job).
 */
export function findLosers(base: VariantReport, cand: VariantReport): Loser[] {
  const baseById = new Map(base.results.map(r => [r.queryId, r] as const));
  const losers: Loser[] = [];
  for (const c of cand.results) {
    const b = baseById.get(c.queryId);
    if (!b) continue;
    const drop = METRIC_NAMES.reduce((s, m) => s + Math.max(0, b.metrics[m] - c.metrics[m]), 0);
    if (drop > 1e-9) losers.push({ queryId: c.queryId, category: c.category, base: b.metrics, candidate: c.metrics, drop });
  }
  return losers.sort((x, y) => y.drop - x.drop || x.queryId.localeCompare(y.queryId));
}

export function formatLosers(losers: Loser[], limit = 10): string {
  if (!losers.length) return "";
  const cell = (l: Loser, m: MetricName) => l.candidate[m] < l.base[m] ? `${m} ${l.base[m].toFixed(3)}->${l.candidate[m].toFixed(3)}` : "";
  const lines = [`losers: ${losers.length} quer${losers.length === 1 ? "y" : "ies"} worsened (per-query view, outside the verdict; a mean can hide losers behind winners):`];
  for (const l of losers.slice(0, limit)) lines.push(`  ${l.queryId.padEnd(12)} ${l.category.padEnd(12)} ${METRIC_NAMES.map(m => cell(l, m)).filter(Boolean).join("  ")}`);
  if (losers.length > limit) lines.push(`  (+${losers.length - limit} more)`);
  return lines.join("\n");
}
