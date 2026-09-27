import { buildSyntheticCorpus, SYNTHETIC_CORPORA, type SyntheticId } from "./corpus/synthetic";
import { oracleTable } from "./temporal-oracle";
import { minimumDetectableEffect } from "./stats";
import type { QueryResult, StandingFiringPoint, VariantReport } from "./types";

const f = (n: number) => n.toFixed(3);
const isSynthetic = (id: string): id is SyntheticId => (SYNTHETIC_CORPORA as readonly string[]).includes(id);
const subsetsOf = (r: QueryResult) => (r.tags ?? []).filter(t => t.startsWith("subset:")).map(t => t.slice("subset:".length));
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

const point = (x: StandingFiringPoint) => `threshold ${x.threshold.toFixed(2)}  precision ${f(x.precision)}  recall ${f(x.recall)}  TP ${x.truePositive}  FP ${x.falsePositive}  FN ${x.falseNegative}  same-subject-other-intent fired ${x.intentFired}/${x.intentQueries}`;
const ci = (c: [number, number]) => `[${f(c[0])}, ${f(c[1])}]`;

/** Extra report lines for the synthetic corpora only; core and public reports get none. */
export function syntheticLines(report: VariantReport): string[] {
  if (!isSynthetic(report.corpus)) return [];
  const out: string[] = [];
  const subsets = new Map<string, QueryResult[]>();
  for (const r of report.results) for (const s of subsetsOf(r)) subsets.set(s, [...(subsets.get(s) ?? []), r]);
  if (subsets.size) {
    out.push("  subsets (report only): n, recall@5, recall@10, MRR@10");
    for (const [name, rs] of [...subsets].sort(([a], [b]) => a.localeCompare(b))) out.push(`    ${name.padEnd(24)} n=${rs.length}  ${f(mean(rs.map(r => r.metrics.recall5)))}  ${f(mean(rs.map(r => r.metrics.recall10)))}  ${f(mean(rs.map(r => r.metrics.mrr10)))}`);
  }
  const mrr = report.results.map(r => r.metrics.mrr10);
  if (report.results.length && report.corpus !== "injection") out.push(`  MRR@10 unpaired MDE at 80% power (2.8 x bootstrap SE of the per-query values): ${f(minimumDetectableEffect(mrr, report.results.map(r => r.clusterKey)))}`);

  if (report.corpus === "injection") {
    const share = (r: QueryResult) => r.rankedIds.slice(0, 5).filter(id => id.startsWith("ij-plant-")).length / 5;
    const shares = report.results.map(share);
    // Slot-level binomial MDE: 2.8 x sqrt(p(1-p)/slots), assuming independent slots (conservative next to the near-constant per-query share).
    const p = mean(shares), slots = report.results.length * 5, mde = 2.8 * Math.sqrt(p * (1 - p) / Math.max(1, slots));
    out.push(`  planted top-5 share ${f(p)} (${Math.round(p * slots)}/${slots} slots); binomial MDE at 80% power ${f(mde)}`);
    for (const style of ["command", "role", "factual", "impersonation"]) {
      const rs = report.results.filter(r => subsetsOf(r).includes(`plant-${style}`));
      if (rs.length) out.push(`    ${style.padEnd(14)} planted share ${f(mean(rs.map(share)))} over ${rs.length} queries; own plant rank 1 in ${rs.filter(r => r.rankedIds[0]?.startsWith("ij-plant-")).length}`);
    }
  }

  if (report.corpus === "noise") {
    const email = new Set(buildSyntheticCorpus("noise").entries.filter(e => e.source === "email-gmail").map(e => e.id));
    for (const tier of ["probe-footer-words", "probe-footer-synonym"]) {
      const probes = report.results.filter(r => subsetsOf(r).includes(tier));
      const slots = probes.reduce((n, r) => n + r.rankedIds.slice(0, 3).filter(id => email.has(id)).length, 0);
      out.push(`  ${tier}: email share of top 3 ${f(slots / Math.max(1, probes.length * 3))}; gold note in the top 3 for ${probes.filter(r => r.metrics.mrr10 >= 1 / 3).length}/${probes.length}`);
    }
    const wrongSource = report.results.filter(r => subsetsOf(r).includes("email-control") || subsetsOf(r).includes("recurring")).filter(r => r.rankedIds.slice(0, 5).every(id => !email.has(id))).length;
    out.push(`  email-correct queries with no email in the top 5 (what blanket demotion would cause): ${wrongSource}`);
  }

  if (report.corpus === "temporal") {
    out.push("  supersession oracle (simulated on these rankings; recall@10 / MRR@10). baseline | supersession applied | recency-only reorder:");
    for (const row of oracleTable(report, buildSyntheticCorpus("temporal"))) out.push(`    ${row.scope.padEnd(40)} n=${String(row.n).padEnd(4)} ${f(row.baseline.recall10)}/${f(row.baseline.mrr10)}  |  ${f(row.supersession.recall10)}/${f(row.supersession.mrr10)}  |  ${f(row.recency.recall10)}/${f(row.recency.mrr10)}`);

    // The cancelled move ("bad") is not gold: report how often it still surfaces, a belief-time diagnostic rather
    // than a metric a change could be judged on.
    const retracted = report.results.filter(r => subsetsOf(r).includes("retracted-past"));
    if (retracted.length) {
      const surfaced = retracted.filter(r => r.rankedIds.slice(0, 10).includes(`tm-retracted-${r.clusterKey.replace("tm-", "")}-bad`)).length;
      out.push(`  belief-time diagnostic (not gold): the cancelled move surfaced in the top 10 for ${surfaced}/${retracted.length} retracted-past queries`);
    }
  }

  if (report.standing) {
    const s = report.standing, g = s.groups, all = g.yes + g.overlap + g.intent + g.unrelated;
    out.push(`  standing: ${s.memories} memories; queries ${all} (positive ${g.yes}, overlapping-words negative ${g.overlap}, same-subject-other-intent ${g.intent} [not in precision], unrelated ${g.unrelated}); positive prevalence ${f(g.yes / all)}`);
    for (const name of ["distilled", "raw"] as const) {
      const r = s.inputs[name];
      out.push(`  firing curve, ${name} query embedding (at most 2 per query, all splits):`, ...r.curve.map(x => `    ${point(x)}`));
      const c = r.chosen;
      out.push(`    chosen on dev: threshold ${c.threshold.toFixed(2)} (${c.meetsPrecisionTarget ? "meets" : "misses"} precision 0.9); dev precision ${f(c.dev.precision)} recall ${f(c.dev.recall)}; held-out test precision ${f(c.test.precision)} ${ci(c.test.precisionCi)} recall ${f(c.test.recall)} ${ci(c.test.recallCi)}`);
    }
  }
  return out;
}
