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

// Lowercase field names deliberately (same convention as DecisionCaptureConfig,
// src/decisions/capture.ts): test/unit/config-threading-complete.test.ts flags a bare
// tunable name (CALIBRATION_MIN_N, ...) read outside a `cfg.` qualifier anywhere in src/,
// and these are declarations, not reads — the caller threads cfg.CALIBRATION_MIN_N etc.
// into these lowercase fields.
export interface CalibrationGates {
  minN: number;
  minBucketN: number;
  minTopicN: number;
}

export type CalibrationDirection = "over" | "under" | "in_line";

export interface CalibrationBucket {
  bucket: string;
  n: number;
  nStated: number;
  nInferred: number;
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

export type CalibrationLineKind = "rate" | "in_line" | "no_range";

export interface CalibrationReady {
  ready: true;
  n: number;
  nStated: number;
  nInferred: number;
  brier: number;
  gap: number;
  direction: CalibrationDirection;
  buckets: CalibrationBucket[];
  /** Null when no bucket clears CALIBRATION_MIN_BUCKET_N: there is nothing to headline yet. */
  headlineBucket: string | null;
  topic: CalibrationTopic | null;
  /** The read, as a sentence (design 4.3 / 7.4 item 2): never both this and topicLine describe the same fact. */
  line: string;
  /** Design 7.4 item 4, present only when a topic was named. */
  topicLine: string | null;
  /** Which of `line`'s three templates was used (18-copy-deck.md 8.6): picks the dashboard's
   * ledger.line* key for building the Italian sentence client-side from stated/hit/n below. */
  kind: CalibrationLineKind;
  /** The headline bucket's own mean confidence, as a percentage — the exact number `line` cites.
   * Null unless kind is "rate": the other two kinds have no single bucket's rate to name. */
  stated: number | null;
  /** The headline bucket's own hit rate, as a percentage — the exact number `line` cites.
   * Null unless kind is "rate", for the same reason as `stated`. */
  hit: number | null;
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
    if (n === 0) {
      return { bucket, n, nStated: 0, nInferred: 0, meanStated: 0, hitRate: 0, ci: [0, 1] as [number, number], shown: false };
    }
    const nStated = items.filter((i) => i.source === "stated").length;
    const nInferred = items.filter((i) => i.source === "inferred").length;
    const meanStated = mean(items.map((i) => i.pPrime));
    const successes = items.reduce((acc, i) => acc + i.hitPrime, 0);
    return { bucket, n, nStated, nInferred, meanStated, hitRate: successes / n, ci: wilsonInterval(successes, n), shown: n >= minBucketN };
  });
}

/**
 * The largest bucket that clears CALIBRATION_MIN_BUCKET_N, or null when none
 * does — a rate must never be headlined from a bucket the disclosure gate
 * would otherwise hide (a 2-decision bucket has no business fronting the
 * line just because it happens to be the biggest of five equally-thin
 * ones). Ties go to the HIGHER confidence bucket: buckets is already in
 * BUCKET_ORDER (ascending), so `>=` lets a later, equal-n bucket win.
 */
function headlineBucketOf(buckets: readonly CalibrationBucket[]): CalibrationBucket | null {
  const eligible = buckets.filter((b) => b.shown);
  if (!eligible.length) return null;
  return eligible.reduce((best, b) => (b.n >= best.n ? b : best), eligible[0]);
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

/** "1 decision" vs "14 decisions" (18-copy-deck.md 8.6: "{n} counts need the one/other plural"). */
function decisionWord(n: number): string {
  return n === 1 ? "decision" : "decisions";
}

/**
 * The headline sentence cites the HEADLINE BUCKET's own n and inferred
 * count, never the overall n (18-copy-deck.md section 5.3, honesty bug): a
 * rate built from 5 decisions in the 70% bucket must not be captioned with a
 * count of 14 just because 14 decisions exist overall.
 *
 * When no bucket clears CALIBRATION_MIN_BUCKET_N, there is no single rate
 * honest to show (the disclosure gate exists for exactly this), so the line
 * says so instead of picking one anyway. Wording is 18-copy-deck.md 8.6: the
 * confidence sits in the subject ("when you were about X% sure"), not the
 * object ("your X% calls"), which read as "X% of your calls" instead of "you,
 * about X% sure".
 */
function mainLine(direction: CalibrationDirection, headline: CalibrationBucket | null, overallN: number, minBucketN: number): string {
  if (direction === "in_line") {
    return `So far, how sure you were roughly matches how things turned out, based on ${overallN} ${decisionWord(overallN)}.`;
  }
  if (!headline) {
    return `You'll see how often you're right once ${minBucketN} decisions share a similar confidence. You have ${overallN} so far.`;
  }
  const rate = `So far, when you were about ${pct(headline.meanStated)}% sure, you were right ${pct(headline.hitRate)}% of the time, `
    + `based on ${headline.n} ${decisionWord(headline.n)}.`;
  if (headline.nInferred === 0) return rate;
  return `${rate} For ${headline.nInferred} of them, that figure was estimated from your wording.`;
}

function topicLineOf(topic: CalibrationTopic): string {
  const phrase = topic.direction === "over" ? "less often than you expected" : "more often than you expected";
  return `On ${topic.name}, you've been right ${phrase} so far, based on ${topic.n} ${decisionWord(topic.n)}.`;
}

/** Calibration for one caller's decisions, already read and scoped by the queries module. Pure: no I/O. */
export function calibrate(rows: readonly DecisionOutcomeRow[], gates: CalibrationGates): CalibrationResult {
  const scored = scoreRows(rows);
  const n = scored.length;
  if (n < gates.minN) {
    return {
      ready: false,
      n,
      needed: gates.minN,
      line: `You'll see how your confidence compares with what happened after ${gates.minN} reviewed decisions. You have ${n} so far.`,
    };
  }

  const nStated = scored.filter((s) => s.source === "stated").length;
  const nInferred = scored.filter((s) => s.source === "inferred").length;
  const brier = mean(scored.map((s) => (s.p - s.hit) ** 2));
  const meanPPrime = mean(scored.map((s) => s.pPrime));
  const meanHitPrime = mean(scored.map((s) => s.hitPrime));
  const sumHitPrime = scored.reduce((acc, s) => acc + s.hitPrime, 0);
  const direction = directionOf(meanPPrime, sumHitPrime, n);
  const buckets = buildBuckets(scored, gates.minBucketN);
  const headlineBucket = headlineBucketOf(buckets);
  const topic = findTopic(scored, gates.minTopicN);
  // 18-copy-deck.md 8.6: which of mainLine's three templates fired, and the exact numbers it
  // cites — a headline built from one bucket must expose THAT bucket's own stated/hit, not the
  // overall ones above, so the dashboard's Italian sentence matches the English `line` exactly.
  const kind: CalibrationLineKind = direction === "in_line" ? "in_line" : headlineBucket ? "rate" : "no_range";

  return {
    ready: true,
    n,
    nStated,
    nInferred,
    brier,
    gap: meanPPrime - meanHitPrime,
    direction,
    buckets,
    headlineBucket: headlineBucket?.bucket ?? null,
    topic,
    line: mainLine(direction, headlineBucket, n, gates.minBucketN),
    topicLine: topic ? topicLineOf(topic) : null,
    kind,
    stated: kind === "rate" ? pct(headlineBucket!.meanStated) : null,
    hit: kind === "rate" ? pct(headlineBucket!.hitRate) : null,
  };
}
