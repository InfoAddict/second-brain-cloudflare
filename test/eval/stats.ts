/** Small, seedable PRNG (mulberry32). Never Math.random: the gate must be reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapCI { mean: number; lo: number; hi: number; n: number; clusters: number }
export interface BootstrapOptions { iterations?: number; seed?: number; alpha?: number }
export const BOOTSTRAP_DEFAULTS = { iterations: 10_000, seed: 20260923, alpha: 0.05 } as const;

/**
 * Percentile interval for the mean of paired per-query deltas, resampling
 * whole clusters (queries that share a source memory move together).
 */
export function pairedBootstrap(
  deltas: readonly number[],
  clusterKeys: readonly string[],
  opts: BootstrapOptions = {},
): BootstrapCI {
  if (deltas.length !== clusterKeys.length) throw new Error("deltas and clusterKeys must align");
  const { iterations, seed, alpha } = { ...BOOTSTRAP_DEFAULTS, ...opts };
  const n = deltas.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0, n: 0, clusters: 0 };

  const byCluster = new Map<string, { sum: number; count: number }>();
  deltas.forEach((d, i) => {
    const c = byCluster.get(clusterKeys[i]) ?? { sum: 0, count: 0 };
    c.sum += d;
    c.count += 1;
    byCluster.set(clusterKeys[i], c);
  });
  const groups = [...byCluster.values()];
  const rand = mulberry32(seed);
  const reps = new Float64Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let sum = 0, count = 0;
    for (let g = 0; g < groups.length; g++) {
      const pick = groups[Math.floor(rand() * groups.length)];
      sum += pick.sum;
      count += pick.count;
    }
    reps[b] = sum / count;
  }
  reps.sort();
  return {
    mean: deltas.reduce((s, d) => s + d, 0) / n,
    lo: reps[Math.floor((alpha / 2) * iterations)],
    hi: reps[Math.min(iterations - 1, Math.ceil((1 - alpha / 2) * iterations) - 1)],
    n,
    clusters: groups.length,
  };
}

/**
 * Smallest true mean delta detectable at 80% power, two-sided 95% (z = 1.96 + 0.84), in the unit the gate's interval
 * resamples: whole clusters. Deltas are averaged within each cluster, and the sd over those cluster means is divided by
 * sqrt(clusters). Without keys every delta is its own cluster.
 */
export function minimumDetectableEffect(deltas: readonly number[], clusterKeys?: readonly string[]): number {
  const byCluster = new Map<string, { sum: number; count: number }>();
  deltas.forEach((d, i) => {
    const key = clusterKeys ? clusterKeys[i] : String(i);
    const c = byCluster.get(key) ?? { sum: 0, count: 0 };
    c.sum += d;
    c.count += 1;
    byCluster.set(key, c);
  });
  const means = [...byCluster.values()].map(c => c.sum / c.count);
  const n = means.length;
  if (n < 2) return 0;
  const m = means.reduce((s, d) => s + d, 0) / n;
  const variance = means.reduce((s, d) => s + (d - m) ** 2, 0) / (n - 1);
  return 2.8 * Math.sqrt(variance) / Math.sqrt(n);
}
