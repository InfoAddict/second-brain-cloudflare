import { describe, expect, it } from "vitest";
import { HIDDEN_VALIDATION_CASES } from "../fixtures/recall-root-quality-hidden";
import { ROOT_QUALITY_CASES, type RootQualityCase } from "../fixtures/recall-root-quality";
import { ftsEligibleToken } from "../../src/recall/fts";
import { tokenizeQuery } from "../../src/text/tokenize";
import { HIDDEN_GATES, KNOWN_GAPS, ROOT_QUALITY_GATES, type Gate } from "./legacy/gates";
import { LEGACY_MODES, evaluateLegacy, type LegacyMetrics, type LegacyMode } from "./legacy/harness";

const rootId = (c: RootQualityCase) => `${c.domain}/${c.failureShape}`;
const hiddenId = (c: RootQualityCase) => `${c.domain}/${c.failureShape}/${c.query}`;
const hasShortToken = (q: string) => tokenizeQuery(q).some(t => !ftsEligibleToken(t));
const report = (label: string, mode: LegacyMode, metrics: LegacyMetrics) => {
  if (process.env.RECALL_BENCHMARK_REPORT === "1") console.info(`LEGACY_REAL_SQL ${label} ${mode} ${JSON.stringify(metrics)}`);
};

function assertGates(suite: string, mode: LegacyMode, metrics: LegacyMetrics, gates: readonly Gate[]) {
  for (const gate of gates) {
    const key = `${suite}/${mode}/${gate.name}`;
    const gap = KNOWN_GAPS[key];
    if (gap) expect(gate.holds(metrics), `${key} is a known gap (${gap.item}, measured ${gap.measured}); it now holds, so remove the KNOWN_GAPS entry`).toBe(false);
    else expect(gate.holds(metrics), `${key}: ${JSON.stringify(metrics)}`).toBe(true);
  }
}

describe.each(LEGACY_MODES)("legacy benchmarks on real SQL, honest baseline: %s mode", (mode) => {
  it("root-quality: every original frozen gate, per split and overall", async () => {
    const opts = { idOf: rootId, pool: "like" as const };
    const dev = await evaluateLegacy(ROOT_QUALITY_CASES.filter(c => c.split === "development"), mode, opts);
    const hold = await evaluateLegacy(ROOT_QUALITY_CASES.filter(c => c.split === "holdout"), mode, opts);
    const all = await evaluateLegacy(ROOT_QUALITY_CASES, mode, opts);
    report("root-quality/development", mode, dev.metrics);
    report("root-quality/holdout", mode, hold.metrics);
    report("root-quality/overall", mode, all.metrics);
    for (const { observations } of [dev, hold, all]) {
      for (const o of observations) if (!hasShortToken(o.query)) expect(o.ftsUsed, `${o.id} (${mode})`).toBe(mode !== "like");
    }
    assertGates("root-quality/development", mode, dev.metrics, ROOT_QUALITY_GATES.development);
    assertGates("root-quality/holdout", mode, hold.metrics, ROOT_QUALITY_GATES.holdout);
    assertGates("root-quality/overall", mode, all.metrics, ROOT_QUALITY_GATES.overall);
  });

  it("hidden validation: every original frozen gate", async () => {
    const { metrics, observations } = await evaluateLegacy(HIDDEN_VALIDATION_CASES, mode, { idOf: hiddenId, pool: "like" });
    report("hidden", mode, metrics);
    for (const o of observations) if (!hasShortToken(o.query)) expect(o.ftsUsed, `${o.id} (${mode})`).toBe(mode !== "like");
    assertGates("hidden", mode, metrics, HIDDEN_GATES);
    for (const domain of ["personal", "enterprise", "product", "architecture"] as const) {
      const rows = observations.filter(o => o.domain === domain);
      expect(rows.filter(o => o.authoritative).length, `${domain} (${mode})`).toBeGreaterThanOrEqual(rows.filter(o => o.baselineAuthoritative).length);
    }
  });
});

describe("legacy cross-mode gates (kept from the retired ports)", () => {
  it.each([
    ["root-quality", ROOT_QUALITY_CASES, rootId],
    ["hidden", HIDDEN_VALIDATION_CASES, hiddenId],
  ] as const)("%s: fts-orderless never scores below like, and fts never below fts-orderless", async (suite, cases, idOf) => {
    const byMode = {} as Record<LegacyMode, LegacyMetrics>;
    for (const mode of LEGACY_MODES) byMode[mode] = (await evaluateLegacy(cases, mode, { idOf, pool: "like" })).metrics;
    const details = JSON.stringify(byMode, null, 2);
    const comparisons: [string, boolean][] = [
      ["fts-orderless authoritativeAnswers >= like", byMode["fts-orderless"].authoritativeAnswers >= byMode.like.authoritativeAnswers],
      ["fts-orderless directTopFourRegressions <= like", byMode["fts-orderless"].directTopFourRegressions <= byMode.like.directTopFourRegressions],
      ["fts authoritativeAnswers >= fts-orderless", byMode.fts.authoritativeAnswers >= byMode["fts-orderless"].authoritativeAnswers],
      ["fts directTopFourRegressions <= fts-orderless", byMode.fts.directTopFourRegressions <= byMode["fts-orderless"].directTopFourRegressions],
    ];
    for (const [name, holds] of comparisons) {
      const key = `cross-mode/${suite}/${name}`;
      const gap = KNOWN_GAPS[key];
      if (gap) expect(holds, `${key} is a known gap (${gap.item}, measured ${gap.measured}); it now holds, so remove the KNOWN_GAPS entry`).toBe(false);
      else expect(holds, `${key}: ${details}`).toBe(true);
    }
  });
});

describe("evaluateLegacy", () => {
  it("returns one observation for one case", async () => {
    const { observations, metrics } = await evaluateLegacy(ROOT_QUALITY_CASES.slice(0, 1), "like", { idOf: rootId, pool: "like" });
    expect(observations).toHaveLength(1);
    expect(metrics.cases).toBe(1);
  });

  it("is deterministic: two runs give identical outputs", async () => {
    const opts = { idOf: hiddenId, pool: "like" as const };
    const a = await evaluateLegacy(HIDDEN_VALIDATION_CASES, "fts", opts);
    const b = await evaluateLegacy(HIDDEN_VALIDATION_CASES, "fts", opts);
    expect(b.observations.map(o => o.outputIds)).toEqual(a.observations.map(o => o.outputIds));
  });
});
