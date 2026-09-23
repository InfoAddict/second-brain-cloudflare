import type { LegacyMetrics } from "./harness";

export interface Gate { name: string; holds: (m: LegacyMetrics) => boolean }

const common: Gate[] = [
  { name: "usefulGraphPrecision >= 0.7", holds: m => m.usefulGraphPrecision >= 0.7 },
  { name: "directTopFourRegressions == 0", holds: m => m.directTopFourRegressions === 0 },
  { name: "extraAiCalls == 0", holds: m => m.extraAiCalls === 0 },
  { name: "extraVectorizeQueries == 0", holds: m => m.extraVectorizeQueries === 0 },
];

// Transcribed verbatim from the mock originals (recall-root-quality-benchmark.test.ts,
// recall-root-quality-hidden-validation.test.ts). No threshold is edited here.
export const ROOT_QUALITY_GATES = {
  development: [
    { name: "cases == 10", holds: (m: LegacyMetrics) => m.cases === 10 },
    { name: "candidateAvailability == 8", holds: (m: LegacyMetrics) => m.candidateAvailability === 8 },
    { name: "fusionSurvival == 8", holds: (m: LegacyMetrics) => m.fusionSurvival === 8 },
    { name: "seedHits >= 7", holds: (m: LegacyMetrics) => m.seedHits >= 7 },
    ...common,
  ],
  holdout: [
    { name: "cases == 10", holds: (m: LegacyMetrics) => m.cases === 10 },
    { name: "candidateAvailability == 8", holds: (m: LegacyMetrics) => m.candidateAvailability === 8 },
    { name: "fusionSurvival == 8", holds: (m: LegacyMetrics) => m.fusionSurvival === 8 },
    { name: "seedHits >= 6", holds: (m: LegacyMetrics) => m.seedHits >= 6 },
    ...common,
  ],
  overall: [
    { name: "candidateAvailability == 16", holds: (m: LegacyMetrics) => m.candidateAvailability === 16 },
    { name: "seedHits >= 13", holds: (m: LegacyMetrics) => m.seedHits >= 13 },
    { name: "authoritativeAnswers >= 14", holds: (m: LegacyMetrics) => m.authoritativeAnswers >= 14 },
    { name: "improvement >= 4", holds: (m: LegacyMetrics) => m.authoritativeAnswers - m.baselineAuthoritativeAnswers >= 4 },
    ...common,
  ],
} as const;

export const HIDDEN_GATES: Gate[] = [
  { name: "cases == 10", holds: m => m.cases === 10 },
  { name: "candidateAvailability == 8", holds: m => m.candidateAvailability === 8 },
  { name: "seedHits >= 7", holds: m => m.seedHits >= 7 },
  { name: "improvement >= 2", holds: m => m.improvement >= 2 },
  ...common,
];

type GapMeasure = Partial<Record<"like" | "fts-orderless" | "fts", string>> | string;

/**
 * Original frozen gates that do not hold under the honest baseline, with the
 * measured value and the board item that owns them. An entry flips its
 * assertion to "must still fail", so closing the gap fails the test and forces
 * the entry's removal. Entries are added only with a decision, never to make a
 * run green. Key format: "<suite>/<mode>/<gate name>", and
 * "cross-mode/<suite>/<comparison>" for the like < orderless < fts gates.
 * Measured on c58c941 (like, fts-orderless, fts unless a mode is named).
 */
export const KNOWN_GAPS: Record<string, { measured: string; item: string }> = {};

function gap(suite: string, gate: string, item: string, measured: GapMeasure): void {
  for (const mode of ["like", "fts-orderless", "fts"] as const) {
    KNOWN_GAPS[`${suite}/${mode}/${gate}`] = { measured: typeof measured === "string" ? measured : measured[mode]!, item };
  }
}

gap("root-quality/development", "seedHits >= 7", "T-0057.4", "6");
gap("root-quality/overall", "authoritativeAnswers >= 14", "T-0057.4", "12");
gap("root-quality/overall", "improvement >= 4", "T-0057.4", "-1 (12 vs baseline 13)");
gap("root-quality/development", "directTopFourRegressions == 0", "T-0057.3", "2");
gap("root-quality/holdout", "directTopFourRegressions == 0", "T-0057.3", "2");
gap("root-quality/overall", "directTopFourRegressions == 0", "T-0057.3", "4");
gap("hidden", "directTopFourRegressions == 0", "T-0057.3", { like: "5", "fts-orderless": "5", fts: "6" });
gap("hidden", "improvement >= 2", "T-0057.1", "0 (8 vs baseline 8)");

/** Cross-mode gates (fts-orderless >= like, fts >= fts-orderless) that do not hold. */
KNOWN_GAPS["cross-mode/hidden/fts directTopFourRegressions <= fts-orderless"] = { measured: "6 vs 5", item: "T-0057.2" };
