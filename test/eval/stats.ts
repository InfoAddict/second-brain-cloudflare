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

export interface BootstrapCI { mean: number; lo: number; hi: number; n: number; clusters: number; /** SD of the replicates the interval is cut from */ se: number }
export interface BootstrapOptions { iterations?: number; seed?: number; alpha?: number }
export const BOOTSTRAP_DEFAULTS = { iterations: 10_000, seed: 20260923, alpha: 0.05 } as const;

/** The bootstrap replicates of the query-weighted mean delta, resampling whole clusters. Shared by the interval and the MDE. */
function bootstrapReplicates(deltas: readonly number[], clusterKeys: readonly string[], iterations: number, seed: number): { reps: Float64Array; clusters: number } {
  if (deltas.length !== clusterKeys.length) throw new Error("deltas and clusterKeys must align");
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
  return { reps, clusters: groups.length };
}

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
  if (n === 0) return { mean: 0, lo: 0, hi: 0, n: 0, clusters: 0, se: 0 };
  const { reps, clusters } = bootstrapReplicates(deltas, clusterKeys, iterations, seed);
  const se = replicateSd(reps, deltas);
  reps.sort();
  return {
    mean: deltas.reduce((s, d) => s + d, 0) / n,
    lo: reps[Math.floor((alpha / 2) * iterations)],
    hi: reps[Math.min(iterations - 1, Math.ceil((1 - alpha / 2) * iterations) - 1)],
    n,
    clusters,
    se,
  };
}

function replicateSd(reps: Float64Array, deltas: readonly number[]): number {
  if (deltas.length < 2 || deltas.every(d => d === deltas[0])) return 0; // no spread, no uncertainty (and no float noise)
  const m = reps.reduce((s, x) => s + x, 0) / reps.length;
  return Math.sqrt(reps.reduce((s, x) => s + (x - m) ** 2, 0) / (reps.length - 1));
}

/** Standard deviation of the bootstrap replicates the interval is cut from (same clusters, weights, seed). */
export function bootstrapStandardError(deltas: readonly number[], clusterKeys: readonly string[], opts: BootstrapOptions = {}): number {
  const { iterations, seed } = { ...BOOTSTRAP_DEFAULTS, ...opts };
  return replicateSd(bootstrapReplicates(deltas, clusterKeys, iterations, seed).reps, deltas);
}

/**
 * Smallest true mean delta detectable at 80% power, two-sided 95% (z = 1.96 + 0.84): 2.8 x the standard error of the
 * mean delta, taken from the same bootstrap the gate's interval uses, so the two cannot disagree about the unit
 * (whole clusters) or the weighting (clusters count by their queries). Without keys each delta is its own cluster.
 */
export function minimumDetectableEffect(deltas: readonly number[], clusterKeys: readonly string[] = deltas.map((_, i) => String(i)), opts: BootstrapOptions = {}): number {
  return 2.8 * bootstrapStandardError(deltas, clusterKeys, opts);
}
