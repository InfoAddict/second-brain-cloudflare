import type { LegacyMetrics } from "./harness";

export interface Gate {
  name: string;
  /** The metric the gate reads; a KNOWN_GAPS entry ratchets this metric. */
  metric: keyof LegacyMetrics;
  holds: (m: LegacyMetrics) => boolean;
}

export interface GapEntry {
  metric: keyof LegacyMetrics;
  /** Exact measured value; equality is asserted, so moving either way needs a deliberate edit. */
  value: number | null;
  item: string;
}

export type GapTable = Record<string, GapEntry>;

/**
 * A judgment call, not a derivation. The mock's floors (root-quality 4, hidden 2)
 * fit several formulas equally: headroom/3 (candidateAvailability minus baseline
 * answers, so (16-4)/3 and (8-2)/3), candidateAvailability/4 and cases/5. This
 * form was chosen because it is the only one that responds to the baseline's
 * strength: on the honest baseline (13/20, 8/8) it gives 1 and 0, where the
 * others would demand 4 and 2 of a baseline that leaves almost no room. That
 * relaxed relative gate is safe only because absolute floors sit beside it:
 * root-quality authoritativeAnswers >= 14 and hidden authoritativeAnswers >= 8.
 */
export function improvementFloor(m: LegacyMetrics): number {
  return Math.ceil((m.candidateAvailability - m.baselineAuthoritativeAnswers) / 3);
}

const gate = (name: string, metric: keyof LegacyMetrics, holds: Gate["holds"]): Gate => ({ name, metric, holds });

const common: Gate[] = [
  // Replaces directTopFourRegressions == 0, an order-identity metric that scored a promoted answer as a regression.
  gate("authorityRankRegressions == 0", "authorityRankRegressions", m => m.authorityRankRegressions === 0),
  gate("extraAiCalls == 0", "extraAiCalls", m => m.extraAiCalls === 0),
  gate("extraVectorizeQueries == 0", "extraVectorizeQueries", m => m.extraVectorizeQueries === 0),
];
const improvement = gate("improvement >= ceil(headroom / 3)", "improvement", m => m.improvement >= improvementFloor(m));
const reach = (n: number) => gate(`neighborhoodReach >= ${n}`, "neighborhoodReach", m => m.neighborhoodReach >= n);
// null (no related id selected) fails: an empty denominator is not a pass.
const precision = gate("usefulGraphPrecision >= 0.7", "usefulGraphPrecision", m => m.usefulGraphPrecision !== null && m.usefulGraphPrecision >= 0.7);

// Counts, seed and answer floors are the mock originals' (recall-root-quality-benchmark.test.ts,
// recall-root-quality-hidden-validation.test.ts). Reach floors are the mock's measured
// neighborhoodReach when those gates were frozen (6 per 10-case scope, 12 overall); the
// originals reported but never asserted it. Only the directTopFour gates and the two
// improvement floors were re-derived (see above and the commit message).
export const ROOT_QUALITY_GATES = {
  development: [
    gate("cases == 10", "cases", m => m.cases === 10),
    gate("candidateAvailability == 8", "candidateAvailability", m => m.candidateAvailability === 8),
    gate("fusionSurvival == 8", "fusionSurvival", m => m.fusionSurvival === 8),
    gate("seedHits >= 7", "seedHits", m => m.seedHits >= 7),
    ...common,
  ],
  holdout: [
    gate("cases == 10", "cases", m => m.cases === 10),
    gate("candidateAvailability == 8", "candidateAvailability", m => m.candidateAvailability === 8),
    gate("fusionSurvival == 8", "fusionSurvival", m => m.fusionSurvival === 8),
    gate("seedHits >= 6", "seedHits", m => m.seedHits >= 6),
    ...common,
  ],
  overall: [
    gate("candidateAvailability == 16", "candidateAvailability", m => m.candidateAvailability === 16),
    gate("seedHits >= 13", "seedHits", m => m.seedHits >= 13),
    gate("authoritativeAnswers >= 14", "authoritativeAnswers", m => m.authoritativeAnswers >= 14),
    improvement,
    ...common,
  ],
} as const;

export const HIDDEN_GATES: Gate[] = [
  gate("cases == 10", "cases", m => m.cases === 10),
  gate("candidateAvailability == 8", "candidateAvailability", m => m.candidateAvailability === 8),
  gate("seedHits >= 7", "seedHits", m => m.seedHits >= 7),
  // Absolute floor: with the relative improvement gate, a pipeline and baseline that degrade together would pass.
  gate("authoritativeAnswers >= 8", "authoritativeAnswers", m => m.authoritativeAnswers >= 8),
  improvement,
  ...common,
];

/**
 * The graph arm's own gates, asserted against the dense-only ablation rather
 * than the shipped pipeline (see LegacyOptions.arms). Under the full pipeline
 * the real keyword arm retrieves every authoritative answer these fixtures put
 * in the corpus, so the answer enters the run as a graph SEED; expandGraph
 * seeds `visited` with the seed ids and never re-emits one, so expandedIds
 * cannot contain the answer and neighborhoodReach reads 0 in all 20 cases
 * however well the graph works. The mock scored 12/20 only because its keyword
 * arm was a controlled list that omitted the answer.
 *
 * Ablating the keyword arm restores the condition the mock measured — the graph
 * is the only route to the answer — and on real SQL the pipeline then reaches
 * it in exactly the mock's 12 of 20 cases, at precision 1.0 over 8 selected
 * related ids. The floors are the mock's measured values, unchanged.
 */
export const GRAPH_REACH_GATES = {
  development: [reach(6), precision],
  holdout: [reach(6), precision],
  overall: [reach(12), precision],
  hidden: [reach(6), precision],
} as const;

/**
 * Baseline convention and its sensitivity. The honest baseline's LIKE pool is
 * built from recall's queryTokens (profile.lexicalTokens), the tokens the
 * frozen pre-plan system (3da4f7a) searched with. Production's LIKE now binds
 * the wider profile.retrievalTokens. That is faithful to the frozen baseline,
 * but the recorded numbers depend on it. Rebuilding the baseline pool on
 * production's terms (measured in like mode, the only mode where the bound
 * terms are observable; fts modes are unchanged) moves the old
 * directTopFourRegressions 4 -> 9 (root-quality) and 5 -> 9 (hidden), and hidden
 * baselineAuthoritative 8 -> 10; root-quality baselineAuthoritative moves
 * 13 -> 11. A test pins the convention (legacy-parity: baseline tokens).
 */

/**
 * Original frozen gates that do not hold under the honest baseline. Each entry
 * ratchets the gate's metric at the exact measured value: if the metric moves
 * in either direction the test fails and asks for a deliberate table edit; if
 * the gate starts to hold it asks for the entry's removal. Entries are added
 * only with a decision, never to make a run green. Key: "<suite>/<mode>/<gate name>".
 */
export const KNOWN_GAPS: GapTable = {};

/**
 * Records one decided gap across all three modes. Unreferenced while the table
 * is empty and kept anyway: adding an entry is a decision, and this is the shape
 * it has to take -- one key per mode, or a gap recorded in `like` would go
 * unratcheted in `fts`.
 */
function gap(suite: string, gateName: string, metric: keyof LegacyMetrics, item: string, value: number | null): void {
  for (const mode of ["like", "fts-orderless", "fts"] as const) {
    KNOWN_GAPS[`${suite}/${mode}/${gateName}`] = { metric, value, item };
  }
}

// Empty, and it is meant to stay that way: an entry is a gap someone decided to
// live with, not a way to make a run green. The last one was root-quality
// development seedHits = 6, where the acceptable root of
// enterprise/popular-broad-summary and architecture/popular-broad-summary is
// dense rank 14 of 15 and the fused root pool is 17 rows against one seed
// budget of topK * 3 = 15. The two arms bid for that budget, so the two
// keyword-only rows the real SQL adds cost the bottom of the dense fetch its
// seats. Fixed in T-0083.6 by giving each arm its own seats (graphSeedLimit and
// lexicalSeedLimit): seedHits is 8 of 8 in all three modes.

/** A failure message for one gate under one suite and mode, or undefined when it behaves as recorded. */
export function checkGate(suite: string, mode: string, m: LegacyMetrics, g: Gate, gaps: GapTable = KNOWN_GAPS): string | undefined {
  const key = `${suite}/${mode}/${g.name}`;
  const entry = gaps[key];
  const holds = g.holds(m);
  if (!entry) return holds ? undefined : `${key} fails: ${g.metric}=${m[g.metric]} ${JSON.stringify(m)}`;
  if (entry.metric !== g.metric) return `${key}: KNOWN_GAPS ratchets ${entry.metric} but the gate reads ${g.metric}`;
  if (holds) return `${key} now holds (${g.metric}=${m[g.metric]}, was ${entry.value}, ${entry.item}); remove the KNOWN_GAPS entry`;
  if (m[entry.metric] !== entry.value) return `${key} moved from ${entry.value} to ${m[entry.metric]} (${entry.item}); update the KNOWN_GAPS entry and its board item deliberately`;
  return undefined;
}
