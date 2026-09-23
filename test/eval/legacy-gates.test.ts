import { describe, expect, it } from "vitest";
import { authorityRank, authorityRankRegressed, type LegacyMetrics } from "./legacy/harness";
import { HIDDEN_GATES, checkGate, improvementFloor, type Gate, type GapTable } from "./legacy/gates";

const base: LegacyMetrics = {
  cases: 10, candidateAvailability: 8, fusionSurvival: 8, seedHits: 6, neighborhoodReach: 0,
  authoritativeAnswers: 6, baselineAuthoritativeAnswers: 8, improvement: -2, usefulGraphPrecision: null,
  authorityRankRegressions: 2, directTopFourRegressions: 3, extraAiCalls: 0, extraVectorizeQueries: 0,
};
const zeroRegressions: Gate = { name: "authorityRankRegressions == 0", metric: "authorityRankRegressions", holds: m => m.authorityRankRegressions === 0 };
const precision: Gate = { name: "usefulGraphPrecision >= 0.7", metric: "usefulGraphPrecision", holds: m => m.usefulGraphPrecision !== null && m.usefulGraphPrecision >= 0.7 };
const gaps: GapTable = {
  "s/like/authorityRankRegressions == 0": { metric: "authorityRankRegressions", value: 2, item: "T-1" },
  "s/like/usefulGraphPrecision >= 0.7": { metric: "usefulGraphPrecision", value: null, item: "T-2" },
};

describe("checkGate ratchet", () => {
  it("passes a gapped gate that still fails at exactly the recorded value", () => {
    expect(checkGate("s", "like", base, zeroRegressions, gaps)).toBeUndefined();
  });

  it("fails when the gapped metric worsens", () => {
    expect(checkGate("s", "like", { ...base, authorityRankRegressions: 10 }, zeroRegressions, gaps)).toMatch(/moved from 2 to 10.*update the KNOWN_GAPS/s);
  });

  it("fails when the gapped metric improves without reaching the gate", () => {
    expect(checkGate("s", "like", { ...base, authorityRankRegressions: 1 }, zeroRegressions, gaps)).toMatch(/moved from 2 to 1.*update the KNOWN_GAPS/s);
  });

  it("fails, asking for removal, when the gate now holds", () => {
    expect(checkGate("s", "like", { ...base, authorityRankRegressions: 0 }, zeroRegressions, gaps)).toMatch(/now holds.*remove/s);
  });

  it("fails an ungapped gate that does not hold", () => {
    expect(checkGate("s", "fts", base, zeroRegressions, gaps)).toMatch(/authorityRankRegressions/);
    expect(checkGate("s", "fts", { ...base, authorityRankRegressions: 0 }, zeroRegressions, gaps)).toBeUndefined();
  });

  it("treats a missing graph-precision denominator as a failure, never a pass", () => {
    expect(precision.holds({ ...base, usefulGraphPrecision: null })).toBe(false);
    expect(precision.holds({ ...base, usefulGraphPrecision: 0.8 })).toBe(true);
    expect(checkGate("s", "fts", { ...base, usefulGraphPrecision: null }, precision, gaps)).toMatch(/usefulGraphPrecision/);
    expect(checkGate("s", "like", { ...base, usefulGraphPrecision: null }, precision, gaps)).toBeUndefined();
    expect(checkGate("s", "like", { ...base, usefulGraphPrecision: 1 }, precision, gaps)).toMatch(/now holds/);
  });

  it("rejects a gap entry whose metric is not the gate's metric", () => {
    const wrong: GapTable = { "s/like/authorityRankRegressions == 0": { metric: "seedHits", value: 6, item: "T-1" } };
    expect(checkGate("s", "like", base, zeroRegressions, wrong)).toMatch(/ratchets seedHits but the gate reads authorityRankRegressions/);
  });
});

describe("improvementFloor", () => {
  it("is a third of the headroom over the baseline, rounded up (the mock's freeze: 12/3=4, 6/3=2)", () => {
    expect(improvementFloor({ ...base, candidateAvailability: 16, baselineAuthoritativeAnswers: 4 })).toBe(4);
    expect(improvementFloor({ ...base, candidateAvailability: 8, baselineAuthoritativeAnswers: 2 })).toBe(2);
    expect(improvementFloor({ ...base, candidateAvailability: 16, baselineAuthoritativeAnswers: 13 })).toBe(1);
    expect(improvementFloor({ ...base, candidateAvailability: 8, baselineAuthoritativeAnswers: 8 })).toBe(0);
  });
});

describe("authority rank", () => {
  const auth = new Set(["a"]);
  it("ranks the first authoritative id, Infinity when absent", () => {
    expect(authorityRank(["x", "y", "a"], auth)).toBe(2);
    expect(authorityRank(["x"], auth)).toBe(Infinity);
  });

  it("regresses only when the answer is strictly lower than the baseline's", () => {
    expect(authorityRankRegressed(["x", "a"], ["a", "x"], auth)).toBe(true);
    expect(authorityRankRegressed(["a", "x"], ["x", "a"], auth)).toBe(false); // promoted
    expect(authorityRankRegressed(["x", "y", "z", "w", "a"], ["a"], auth)).toBe(true);
    expect(authorityRankRegressed(["a"], ["x"], auth)).toBe(false); // answer gained
    expect(authorityRankRegressed(["x"], ["a"], auth)).toBe(true); // answer lost
    expect(authorityRankRegressed(["x"], ["y"], auth)).toBe(false); // absent on both sides
    expect(authorityRankRegressed(["y", "a"], ["x", "a"], auth)).toBe(false); // distractor permutation
  });
});

describe("hidden absolute floor", () => {
  const hidden = (m: Partial<LegacyMetrics>): LegacyMetrics => ({
    ...base, candidateAvailability: 8, seedHits: 8, neighborhoodReach: 6, usefulGraphPrecision: 1,
    authorityRankRegressions: 0, authoritativeAnswers: 8, baselineAuthoritativeAnswers: 8, improvement: 0, ...m,
  });
  const failing = (m: LegacyMetrics) => HIDDEN_GATES.filter(g => !g.holds(m)).map(g => g.name);

  it("holds at today's measurement", () => {
    expect(failing(hidden({}))).toEqual([]);
  });

  it("fails when pipeline and baseline degrade together (8 -> 6 vs 8 -> 5), which the relative gate alone lets through", () => {
    const m = hidden({ authoritativeAnswers: 6, baselineAuthoritativeAnswers: 5, improvement: 1 });
    expect(m.improvement).toBeGreaterThanOrEqual(improvementFloor(m));
    expect(failing(m)).toEqual(["authoritativeAnswers >= 8"]);
  });
});
