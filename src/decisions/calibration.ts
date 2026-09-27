/**
 * Plain-math calibration for the decision ledger: no model call, just
 * arithmetic over already-read rows. Folds confidences below 0.5 onto the
 * other outcome (a 30% call is a 70% call on the other side), buckets the
 * folded confidence, and reports a Brier score on the raw values.
 *
 * Every wording line carries n and never overclaims ("so far", never
 * "always"/"never", never a bare percentage with nothing to anchor it).
 */
import { isTopicTag } from "../compression/eligibility";
import { AXIS_TAGS } from "../insight/eligibility";

export type DecisionOutcome = "right" | "wrong" | "mixed" | "unknown";
export type ConfidenceSource = "stated" | "inferred";

export interface DecisionOutcomeRow {
  confidence: number | null;
  source: ConfidenceSource | null;
  outcome: DecisionOutcome | null;
  tags: string[];
}

export interface CalibrationGates {
  CALIBRATION_MIN_N: number;
  CALIBRATION_MIN_BUCKET_N: number;
  CALIBRATION_MIN_TOPIC_N: number;
}

export type CalibrationDirection = "over" | "under" | "in_line";

export interface CalibrationBucket {
  bucket: string;
  n: number;
  meanStated: number;
  hitRate: number;
  /** Wilson 80% interval on the folded hit rate, with fractional successes. */
  ci: [number, number];
  /** False below CALIBRATION_MIN_BUCKET_N: the row exists but is not shown. */
  shown: boolean;
}

export interface CalibrationTopic {
  name: string;
  n: number;
  gap: number;
  direction: CalibrationDirection;
}

export interface CalibrationNotReady {
  ready: false;
  n: number;
  needed: number;
  line: string;
}

export interface CalibrationReady {
  ready: true;
  n: number;
  nStated: number;
  nInferred: number;
  brier: number;
  gap: number;
  direction: CalibrationDirection;
  buckets: CalibrationBucket[];
  headlineBucket: string;
  topic: CalibrationTopic | null;
  /** The read, as a sentence (design 4.3 / 7.4 item 2): never both this and topicLine describe the same fact. */
  line: string;
  /** Design 7.4 item 4, present only when a topic was named. */
  topicLine: string | null;
}

export type CalibrationResult = CalibrationNotReady | CalibrationReady;

const HIT_BY_OUTCOME: Record<"right" | "wrong" | "mixed", number> = { right: 1, wrong: 0, mixed: 0.5 };
const BUCKET_ORDER = ["50-59", "60-69", "70-79", "80-89", "90-95"] as const;
/** z for an 80% two-tailed Wilson interval (design 4.3: "Wilson 80% interval"). */
const Z_80 = 1.2815515655446004;

interface ScoredRow {
  p: number;
  hit: number;
  source: ConfidenceSource | null;
  pPrime: number;
  hitPrime: number;
  tags: string[];
}

/** Which 10-point bucket a folded confidence (>= 0.5) falls into, by rounded hundredths. */
export function bucketFor(p: number): (typeof BUCKET_ORDER)[number] {
  const h = Math.round(p * 100);
  if (h < 60) return "50-59";
  if (h < 70) return "60-69";
  if (h < 80) return "70-79";
  if (h < 90) return "80-89";
  return "90-95";
}

/** P7.6: below 0.5, a call on the other outcome. At 0.5 nothing changes. */
export function fold(p: number, hit: number): { pPrime: number; hitPrime: number } {
  const h = Math.round(p * 100);
  if (h < 50) return { pPrime: 1 - p, hitPrime: 1 - hit };
  return { pPrime: p, hitPrime: hit };
}

/** Wilson score interval, default 80%, with fractional successes (mixed outcomes score 0.5). */
export function wilsonInterval(successes: number, n: number, z: number = Z_80): [number, number] {
  if (n <= 0) return [0, 1];
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return [Math.max(0, (center - margin) / denom), Math.min(1, (center + margin) / denom)];
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pct(x: number): number {
  return Math.round(x * 100);
}

/** Confidence in (0, 1] on a right/wrong/mixed outcome. unknown and no-confidence rows are listed but never scored. */
function scoreRows(rows: readonly DecisionOutcomeRow[]): ScoredRow[] {
  const scored: ScoredRow[] = [];
  for (const row of rows) {
    if (row.confidence == null) continue;
    if (row.outcome !== "right" && row.outcome !== "wrong" && row.outcome !== "mixed") continue;
    const hit = HIT_BY_OUTCOME[row.outcome];
    const { pPrime, hitPrime } = fold(row.confidence, hit);
    scored.push({ p: row.confidence, hit, source: row.source, pPrime, hitPrime, tags: row.tags });
  }
  return scored;
}

function directionOf(meanPPrime: number, sumHitPrime: number, n: number): CalibrationDirection {
  const [lo, hi] = wilsonInterval(sumHitPrime, n);
  if (meanPPrime > hi) return "over";
  if (meanPPrime < lo) return "under";
  return "in_line";
}

function buildBuckets(scored: readonly ScoredRow[], minBucketN: number): CalibrationBucket[] {
  const groups = new Map<string, ScoredRow[]>(BUCKET_ORDER.map((b) => [b, []]));
  for (const s of scored) groups.get(bucketFor(s.pPrime))!.push(s);

  return BUCKET_ORDER.map((bucket) => {
    const items = groups.get(bucket)!;
    const n = items.length;
    if (n === 0) return { bucket, n, meanStated: 0, hitRate: 0, ci: [0, 1] as [number, number], shown: false };
    const meanStated = mean(items.map((i) => i.pPrime));
    const successes = items.reduce((acc, i) => acc + i.hitPrime, 0);
    return { bucket, n, meanStated, hitRate: successes / n, ci: wilsonInterval(successes, n), shown: n >= minBucketN };
  });
}

function headlineBucketOf(buckets: readonly CalibrationBucket[]): CalibrationBucket {
  return buckets.reduce((best, b) => (b.n > best.n ? b : best), buckets[0]);
}

/** Every tag on a scored row that could name a subject: not reserved, not project:, not an axis tag. */
function topicCandidates(scored: readonly ScoredRow[]): string[] {
  const names = new Set<string>();
  for (const s of scored) {
    for (const tag of s.tags) {
      const t = tag.toLowerCase();
      if (isTopicTag(t) && !AXIS_TAGS.has(t)) names.add(t);
    }
  }
  return [...names];
}

function topicStats(scored: readonly ScoredRow[], name: string): CalibrationTopic {
  const rows = scored.filter((s) => s.tags.some((t) => t.toLowerCase() === name));
  const n = rows.length;
  const meanPPrime = mean(rows.map((r) => r.pPrime));
  const meanHitPrime = mean(rows.map((r) => r.hitPrime));
  const sumHitPrime = rows.reduce((acc, r) => acc + r.hitPrime, 0);
  return { name, n, gap: meanPPrime - meanHitPrime, direction: directionOf(meanPPrime, sumHitPrime, n) };
}

/** At most one topic: largest |gap| among candidates with n >= the gate whose direction is not in_line. Ties: n desc, then name asc. */
function findTopic(scored: readonly ScoredRow[], minTopicN: number): CalibrationTopic | null {
  const candidates = topicCandidates(scored)
    .map((name) => topicStats(scored, name))
    .filter((t) => t.n >= minTopicN && t.direction !== "in_line");
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const byGap = Math.abs(b.gap) - Math.abs(a.gap);
    if (byGap !== 0) return byGap;
    if (b.n !== a.n) return b.n - a.n;
    return a.name.localeCompare(b.name);
  });
  return candidates[0];
}

function mainLine(direction: CalibrationDirection, headline: CalibrationBucket, overall: { n: number; nStated: number; nInferred: number }): string {
  if (direction === "in_line") {
    return `So far your confidence roughly matches how things turned out (n=${overall.n}).`;
  }
  return `Your ${pct(headline.meanStated)}% calls came true ${pct(headline.hitRate)}% of the time so far `
    + `(n=${overall.n}; ${overall.nStated} stated, ${overall.nInferred} inferred).`;
}

function topicLineOf(topic: CalibrationTopic): string {
  const tendency = topic.direction === "over" ? "overconfident" : "underconfident";
  return `On ${topic.name} you have tended to be ${tendency} (n=${topic.n}).`;
}

/** Calibration for one caller's decisions, already read and scoped by the queries module. Pure: no I/O. */
export function calibrate(rows: readonly DecisionOutcomeRow[], gates: CalibrationGates): CalibrationResult {
  const scored = scoreRows(rows);
  const n = scored.length;
  if (n < gates.CALIBRATION_MIN_N) {
    return {
      ready: false,
      n,
      needed: gates.CALIBRATION_MIN_N,
      line: `Calibration appears after ${gates.CALIBRATION_MIN_N} resolved decisions (you have ${n}).`,
    };
  }

  const nStated = scored.filter((s) => s.source === "stated").length;
  const nInferred = scored.filter((s) => s.source === "inferred").length;
  const brier = mean(scored.map((s) => (s.p - s.hit) ** 2));
  const meanPPrime = mean(scored.map((s) => s.pPrime));
  const meanHitPrime = mean(scored.map((s) => s.hitPrime));
  const sumHitPrime = scored.reduce((acc, s) => acc + s.hitPrime, 0);
  const direction = directionOf(meanPPrime, sumHitPrime, n);
  const buckets = buildBuckets(scored, gates.CALIBRATION_MIN_BUCKET_N);
  const headlineBucket = headlineBucketOf(buckets);
  const topic = findTopic(scored, gates.CALIBRATION_MIN_TOPIC_N);
  const overall = { n, nStated, nInferred };

  return {
    ready: true,
    n,
    nStated,
    nInferred,
    brier,
    gap: meanPPrime - meanHitPrime,
    direction,
    buckets,
    headlineBucket: headlineBucket.bucket,
    topic,
    line: mainLine(direction, headlineBucket, overall),
    topicLine: topic ? topicLineOf(topic) : null,
  };
}
