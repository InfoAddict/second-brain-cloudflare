import type { LoadedCorpus } from "./corpus/loader";
import type { GoldenQuery, StandingFiringPoint, StandingInputReport, StandingReport } from "./types";
import { cosine } from "./vectors";

export type StandingGroup = "yes" | "overlap" | "intent" | "unrelated";
export interface StandingProbe {
  group: StandingGroup;
  split: "dev" | "test";
  expected: Set<string>;
  /** Groups queries that are not independent trials (five phrasings of one memory). Defaults to the query id. */
  clusterKey: string;
  /** Cosine to every standing memory, best first. */
  scores: { id: string; value: number }[];
}

/** Standing memories fire at most this many per query. */
const MAX_FIRES = 2;
export const THRESHOLD_GRID = Array.from({ length: 13 }, (_, i) => Number((0.3 + i * 0.05).toFixed(2)));
/** Refined grid (C2): 0.01 steps between 0.60 and 0.80, where the coarse grid's cliff sits. */
export const THRESHOLD_GRID_FINE = Array.from({ length: 21 }, (_, i) => Number((0.6 + i * 0.01).toFixed(2)));
export const PRECISION_TARGET = 0.9;

/**
 * Precision and recall of firing at one cosine threshold. Precision counts every fire on a positive, an overlapping-words
 * negative or an unrelated query; fires on same-subject-different-intent queries are reported apart by default, because
 * whether they are wrong is a product decision, so they must not move precision unless `countIntentAsFalsePositive` asks
 * for the other treatment (Q1's alternative).
 */
export function scoreFiring(probes: readonly StandingProbe[], threshold: number, opts: { countIntentAsFalsePositive?: boolean } = {}): StandingFiringPoint {
  let truePositive = 0, falsePositive = 0, falseNegative = 0, intentFired = 0, intentQueries = 0;
  for (const p of probes) {
    const fired = p.scores.filter(x => x.value >= threshold).slice(0, MAX_FIRES);
    if (p.group === "intent") {
      intentQueries++;
      intentFired += fired.length ? 1 : 0;
      if (opts.countIntentAsFalsePositive) falsePositive += fired.length;
      continue;
    }
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

/**
 * Wilson interval using the number of independent clusters in place of the number of trials, holding the
 * trial-level proportion fixed. True positives cluster by standing memory (five phrasings of one instruction are
 * not five independent trials), so this is wider than `wilson(k, n)` whenever clusters < n, and identical when
 * every trial is its own cluster.
 */
export function wilsonClustered(k: number, n: number, clusters: number): [number, number] {
  if (!n || !clusters) return [0, 1];
  const p = k / n;
  return wilson(p * clusters, clusters);
}

const f1 = (x: StandingFiringPoint) => (x.precision + x.recall ? 2 * x.precision * x.recall / (x.precision + x.recall) : 0);

/** Highest recall among thresholds whose precision meets the target; otherwise the best F1, flagged as missing the target. */
export function chooseThreshold(dev: readonly StandingProbe[], grid: readonly number[], target: number): { threshold: number; meetsPrecisionTarget: boolean } {
  const points = grid.map(t => scoreFiring(dev, t));
  const ok = points.filter(x => x.truePositive + x.falsePositive > 0 && x.precision >= target);
  if (ok.length) return { threshold: ok.reduce((best, x) => (x.recall > best.recall ? x : best)).threshold, meetsPrecisionTarget: true };
  return { threshold: points.reduce((best, x) => (f1(x) > f1(best) ? x : best)).threshold, meetsPrecisionTarget: false };
}

/**
 * The lowest threshold (C2) whose precision meets the target at itself and at the next two 0.01 grid steps, so a
 * one-step spike on the precision cliff can never be chosen; ties at the lowest surviving threshold go to the
 * higher dev recall. Falls back to `chooseThreshold`'s best-F1 rule, flagged as missing the target, when nothing
 * on the grid is stable.
 */
export function chooseStableThreshold(dev: readonly StandingProbe[], grid: readonly number[], target = PRECISION_TARGET): { threshold: number; meetsPrecisionTarget: boolean } {
  const sorted = [...grid].sort((a, b) => a - b);
  const round2 = (x: number) => Number(x.toFixed(2));
  const holds = (t: number) => {
    const p = scoreFiring(dev, t);
    return p.truePositive + p.falsePositive > 0 && p.precision >= target;
  };
  const stableAt = (t: number) => holds(t) && holds(round2(t + 0.01)) && holds(round2(t + 0.02));
  const candidates = sorted.filter(stableAt);
  if (candidates.length) {
    const lowest = candidates[0];
    const tied = candidates.filter(t => t === lowest);
    const best = tied.reduce((best, t) => (scoreFiring(dev, t).recall > scoreFiring(dev, best).recall ? t : best), tied[0]);
    return { threshold: best, meetsPrecisionTarget: true };
  }
  const points = sorted.map(t => scoreFiring(dev, t));
  return { threshold: points.reduce((best, x) => (f1(x) > f1(best) ? x : best)).threshold, meetsPrecisionTarget: false };
}

export function summarizeInput(
  probes: readonly StandingProbe[], grid: readonly number[] = THRESHOLD_GRID, target = PRECISION_TARGET,
  chooseFn: typeof chooseThreshold = chooseThreshold,
): StandingInputReport {
  const dev = probes.filter(p => p.split === "dev"), test = probes.filter(p => p.split === "test");
  const chosen = chooseFn(dev, grid, target);
  const held = scoreFiring(test, chosen.threshold);
  const clustersOf = (ps: readonly StandingProbe[]) => new Set(ps.map(p => p.clusterKey)).size;
  // Precision's clusters are counted over the queries that actually fired (its TP+FP population): counting
  // every test query regardless of firing, as an earlier version of this function did, can make "clusters"
  // exceed the trial count n and the interval narrower than the per-query one instead of wider. Recall's
  // denominator (TP+FN) is every "yes" query whether it fired or not, so its cluster count uses that full set.
  const fired = (p: StandingProbe) => p.scores.filter(x => x.value >= chosen.threshold).slice(0, MAX_FIRES).length > 0;
  const precisionClusters = clustersOf(test.filter(p => p.group !== "intent" && fired(p)));
  const recallClusters = clustersOf(test.filter(p => p.group === "yes"));
  return {
    curve: grid.map(t => scoreFiring(probes, t)),
    chosen: {
      ...chosen,
      dev: scoreFiring(dev, chosen.threshold),
      test: {
        ...held,
        precisionCi: wilson(held.truePositive, held.truePositive + held.falsePositive),
        recallCi: wilson(held.truePositive, held.truePositive + held.falseNegative),
        precisionCiClustered: wilsonClustered(held.truePositive, held.truePositive + held.falsePositive, precisionClusters),
        recallCiClustered: wilsonClustered(held.truePositive, held.truePositive + held.falseNegative, recallClusters),
      },
      intentCountedAsFalsePositive: {
        dev: scoreFiring(dev, chosen.threshold, { countIntentAsFalsePositive: true }),
        test: scoreFiring(test, chosen.threshold, { countIntentAsFalsePositive: true }),
      },
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
  // Vector ids are minted per upload (T-0089.1.1), so each standing memory's first vector is looked up
  // through the row's own vector_ids and scored under its entry id.
  const heads: string[] = [];
  for (const id of corpus.standingIds) {
    const row = await corpus.env.DB.prepare(`SELECT vector_ids FROM entries WHERE id = ?`).bind(id).first<{ vector_ids: string }>();
    const head = (JSON.parse(row?.vector_ids ?? "[]") as string[])[0];
    if (head) heads.push(head);
  }
  const fetched = await corpus.vectorize.getByIds(heads);
  const vectors = fetched.map(v => ({ ...v, id: ((v.metadata as { parentId?: string } | undefined)?.parentId ?? v.id) as string }));
  if (vectors.length !== corpus.standingIds.length) throw new Error(`standing vectors missing: ${vectors.length}/${corpus.standingIds.length}`);
  const build = (name: "distilled" | "raw") => queries.map((q): StandingProbe => {
    const probe = inputs[name].get(q.id);
    if (!probe) throw new Error(`standing query ${q.id} has no ${name} embedding`);
    return {
      group: groupOf(q),
      split: (q.tags ?? []).includes("split:test") ? "test" : "dev",
      expected: new Set(q.gold.map(g => g.id)),
      clusterKey: q.clusterKey ?? q.id,
      scores: vectors.map(v => ({ id: v.id, value: cosine(probe, v.values) })).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id)),
    };
  });
  const groups: StandingReport["groups"] = { yes: 0, overlap: 0, intent: 0, unrelated: 0 };
  for (const q of queries) groups[groupOf(q)]++;
  return {
    groups, memories: vectors.length,
    inputs: {
      distilled: summarizeInput(build("distilled"), THRESHOLD_GRID_FINE, PRECISION_TARGET, chooseStableThreshold),
      raw: summarizeInput(build("raw"), THRESHOLD_GRID_FINE, PRECISION_TARGET, chooseStableThreshold),
    },
  };
}
