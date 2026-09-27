import type { LoadedCorpus } from "./corpus/loader";
import type { GoldenQuery, StandingFiringPoint, StandingInputReport, StandingReport } from "./types";
import { cosine } from "./vectors";

export type StandingGroup = "yes" | "overlap" | "intent" | "unrelated";
export interface StandingProbe {
  group: StandingGroup;
  split: "dev" | "test";
  expected: Set<string>;
  /** Cosine to every standing memory, best first. */
  scores: { id: string; value: number }[];
}

/** Standing memories fire at most this many per query. */
const MAX_FIRES = 2;
export const THRESHOLD_GRID = Array.from({ length: 13 }, (_, i) => Number((0.3 + i * 0.05).toFixed(2)));
export const PRECISION_TARGET = 0.9;

/**
 * Precision and recall of firing at one cosine threshold. Precision counts every fire on a positive, an overlapping-words
 * negative or an unrelated query; fires on same-subject-different-intent queries are reported apart, because whether they
 * are wrong is a product decision still open, so they must not move precision.
 */
export function scoreFiring(probes: readonly StandingProbe[], threshold: number): StandingFiringPoint {
  let truePositive = 0, falsePositive = 0, falseNegative = 0, intentFired = 0, intentQueries = 0;
  for (const p of probes) {
    const fired = p.scores.filter(x => x.value >= threshold).slice(0, MAX_FIRES);
    if (p.group === "intent") { intentQueries++; intentFired += fired.length ? 1 : 0; continue; }
    truePositive += fired.filter(x => p.expected.has(x.id)).length;
    falsePositive += fired.filter(x => !p.expected.has(x.id)).length;
    falseNegative += [...p.expected].filter(id => !fired.some(x => x.id === id)).length;
  }
  return {
    threshold, truePositive, falsePositive, falseNegative, intentFired, intentQueries,
    precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 0,
    recall: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 0,
  };
}

/** Wilson score interval, 95%. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d, half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const f1 = (x: StandingFiringPoint) => (x.precision + x.recall ? 2 * x.precision * x.recall / (x.precision + x.recall) : 0);

/** Highest recall among thresholds whose precision meets the target; otherwise the best F1, flagged as missing the target. */
export function chooseThreshold(dev: readonly StandingProbe[], grid: readonly number[], target: number): { threshold: number; meetsPrecisionTarget: boolean } {
  const points = grid.map(t => scoreFiring(dev, t));
  const ok = points.filter(x => x.truePositive + x.falsePositive > 0 && x.precision >= target);
  if (ok.length) return { threshold: ok.reduce((best, x) => (x.recall > best.recall ? x : best)).threshold, meetsPrecisionTarget: true };
  return { threshold: points.reduce((best, x) => (f1(x) > f1(best) ? x : best)).threshold, meetsPrecisionTarget: false };
}

export function summarizeInput(probes: readonly StandingProbe[], grid: readonly number[] = THRESHOLD_GRID, target = PRECISION_TARGET): StandingInputReport {
  const dev = probes.filter(p => p.split === "dev"), test = probes.filter(p => p.split === "test");
  const chosen = chooseThreshold(dev, grid, target);
  const held = scoreFiring(test, chosen.threshold);
  return {
    curve: grid.map(t => scoreFiring(probes, t)),
    chosen: {
      ...chosen,
      dev: scoreFiring(dev, chosen.threshold),
      test: { ...held, precisionCi: wilson(held.truePositive, held.truePositive + held.falsePositive), recallCi: wilson(held.truePositive, held.truePositive + held.falseNegative) },
    },
  };
}

const groupOf = (q: GoldenQuery): StandingGroup => {
  const tag = (q.tags ?? []).find(t => t.startsWith("standing:"))?.slice("standing:".length);
  if (tag === "yes" || tag === "overlap" || tag === "intent" || tag === "unrelated") return tag;
  throw new Error(`query ${q.id} has no standing group tag`);
};

/** Measures firing for each query embedding input (the distilled one recall really used, and the raw query text). */
export async function measureStanding(corpus: LoadedCorpus, queries: readonly GoldenQuery[], inputs: Record<"distilled" | "raw", ReadonlyMap<string, number[]>>): Promise<StandingReport> {
  const vectors = await corpus.vectorize.getByIds(corpus.standingIds);
  if (vectors.length !== corpus.standingIds.length) throw new Error(`standing vectors missing: ${vectors.length}/${corpus.standingIds.length}`);
  const build = (name: "distilled" | "raw") => queries.map((q): StandingProbe => {
    const probe = inputs[name].get(q.id);
    if (!probe) throw new Error(`standing query ${q.id} has no ${name} embedding`);
    return {
      group: groupOf(q),
      split: (q.tags ?? []).includes("split:test") ? "test" : "dev",
      expected: new Set(q.gold.map(g => g.id)),
      scores: vectors.map(v => ({ id: v.id, value: cosine(probe, v.values) })).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id)),
    };
  });
  const groups: StandingReport["groups"] = { yes: 0, overlap: 0, intent: 0, unrelated: 0 };
  for (const q of queries) groups[groupOf(q)]++;
  return { groups, memories: vectors.length, inputs: { distilled: summarizeInput(build("distilled")), raw: summarizeInput(build("raw")) } };
}
