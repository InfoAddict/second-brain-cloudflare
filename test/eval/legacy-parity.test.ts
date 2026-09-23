import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { HIDDEN_VALIDATION_CASES } from "../fixtures/recall-root-quality-hidden";
import { ROOT_QUALITY_CASES, type RootQualityCase } from "../fixtures/recall-root-quality";
import { ftsEligibleToken } from "../../src/recall/fts";
import { tokenizeQuery } from "../../src/text/tokenize";
import { HIDDEN_GATES, ROOT_QUALITY_GATES, checkGate, type Gate } from "./legacy/gates";
import {
  LEGACY_MODES, evaluateLegacy, summarizeLegacy,
  type LegacyMetrics, type LegacyMode, type LegacyObservation,
} from "./legacy/harness";

const rootId = (c: RootQualityCase) => `${c.domain}/${c.failureShape}`;
const hiddenId = (c: RootQualityCase) => `${c.domain}/${c.failureShape}/${c.query}`;
const hasShortToken = (q: string) => tokenizeQuery(q).some(t => !ftsEligibleToken(t));

const DEVELOPMENT = ROOT_QUALITY_CASES.filter(c => c.split === "development");
const HOLDOUT = ROOT_QUALITY_CASES.filter(c => c.split === "holdout");

// Each (scope, mode) is evaluated once; every test reads the same result.
type Evaluated = { observations: LegacyObservation[]; metrics: LegacyMetrics };
const memo = new Map<string, Promise<Evaluated>>();
function evaluated(scope: "development" | "holdout" | "hidden", mode: LegacyMode): Promise<Evaluated> {
  const key = `${scope}/${mode}`;
  if (!memo.has(key)) {
    memo.set(key, scope === "hidden"
      ? evaluateLegacy(HIDDEN_VALIDATION_CASES, mode, { idOf: hiddenId, pool: "like" })
      : evaluateLegacy(scope === "development" ? DEVELOPMENT : HOLDOUT, mode, { idOf: rootId, pool: "like" }));
  }
  return memo.get(key)!;
}

async function rootQuality(mode: LegacyMode) {
  const dev = await evaluated("development", mode);
  const hold = await evaluated("holdout", mode);
  const observations = [...dev.observations, ...hold.observations];
  return { dev, hold, all: { observations, metrics: summarizeLegacy(observations, ROOT_QUALITY_CASES, rootId) } };
}

// RECALL_BENCHMARK_REPORT=1 writes the measured metrics to this file (vitest's default reporter hides console output).
const REPORT_FILE = ".eval-cache/legacy-real-sql.jsonl";
const reporting = process.env.RECALL_BENCHMARK_REPORT === "1";
beforeAll(() => {
  if (!reporting) return;
  mkdirSync(".eval-cache", { recursive: true });
  writeFileSync(REPORT_FILE, "");
});
const report = (label: string, mode: LegacyMode, metrics: LegacyMetrics) => {
  if (reporting) appendFileSync(REPORT_FILE, JSON.stringify({ label, mode, metrics }) + "\n");
};

function expectGates(suite: string, mode: LegacyMode, metrics: LegacyMetrics, gates: readonly Gate[]) {
  const failures = gates.map(g => checkGate(suite, mode, metrics, g)).filter((f): f is string => f !== undefined);
  expect(failures, failures.join("\n")).toEqual([]);
}

describe.each(LEGACY_MODES)("legacy benchmarks on real SQL, honest baseline: %s mode", (mode) => {
  it("root-quality: every original frozen gate, per split and overall", async () => {
    const { dev, hold, all } = await rootQuality(mode);
    report("root-quality/development", mode, dev.metrics);
    report("root-quality/holdout", mode, hold.metrics);
    report("root-quality/overall", mode, all.metrics);
    for (const o of all.observations) if (!hasShortToken(o.query)) expect(o.ftsUsed, `${o.id} (${mode})`).toBe(mode !== "like");
    expectGates("root-quality/development", mode, dev.metrics, ROOT_QUALITY_GATES.development);
    expectGates("root-quality/holdout", mode, hold.metrics, ROOT_QUALITY_GATES.holdout);
    expectGates("root-quality/overall", mode, all.metrics, ROOT_QUALITY_GATES.overall);
  });

  it("hidden validation: every original frozen gate", async () => {
    const { metrics, observations } = await evaluated("hidden", mode);
    report("hidden", mode, metrics);
    for (const o of observations) if (!hasShortToken(o.query)) expect(o.ftsUsed, `${o.id} (${mode})`).toBe(mode !== "like");
    expectGates("hidden", mode, metrics, HIDDEN_GATES);
    for (const domain of ["personal", "enterprise", "product", "architecture"] as const) {
      const rows = observations.filter(o => o.domain === domain);
      expect(rows.filter(o => o.authoritative).length, `${domain} (${mode})`).toBeGreaterThanOrEqual(rows.filter(o => o.baselineAuthoritative).length);
    }
  });
});

describe("legacy cross-mode gates (kept from the retired ports)", () => {
  const scopes: [string, (mode: LegacyMode) => Promise<LegacyMetrics>][] = [
    ["root-quality/development", async mode => (await evaluated("development", mode)).metrics],
    ["root-quality/holdout", async mode => (await evaluated("holdout", mode)).metrics],
    ["root-quality/overall", async mode => (await rootQuality(mode)).all.metrics],
    ["hidden", async mode => (await evaluated("hidden", mode)).metrics],
  ];
  // Answers, not top-four order: bm25 length-normalization legitimately permutes equally irrelevant distractors.
  it.each(scopes)("%s: fts-orderless never answers fewer cases than like, and fts never fewer than fts-orderless", async (_scope, metricsFor) => {
    const byMode = {} as Record<LegacyMode, LegacyMetrics>;
    for (const mode of LEGACY_MODES) byMode[mode] = await metricsFor(mode);
    const details = JSON.stringify(byMode, null, 2);
    expect(byMode["fts-orderless"].authoritativeAnswers, details).toBeGreaterThanOrEqual(byMode.like.authoritativeAnswers);
    expect(byMode.fts.authoritativeAnswers, details).toBeGreaterThanOrEqual(byMode["fts-orderless"].authoritativeAnswers);
    expect(byMode["fts-orderless"].authorityRankRegressions, details).toBeLessThanOrEqual(byMode.like.authorityRankRegressions);
    expect(byMode.fts.authorityRankRegressions, details).toBeLessThanOrEqual(byMode["fts-orderless"].authorityRankRegressions);
  });
});

describe("baseline pool convention", () => {
  it("builds the like pool from recall's lexicalTokens, not production's wider retrievalTokens", async () => {
    const c = ROOT_QUALITY_CASES.find(x => x.domain === "personal" && x.failureShape === "long-parent-pollution")!;
    const { observations } = await evaluated("development", "like");
    const o = observations.find(x => x.id === rootId(c))!;
    // Distilled tokens only. Production's LIKE binds [maple, venue, booking, permit, book] here (evidence tokens
    // plus the "book" stem variant); a silent switch to them would move every recorded gap.
    expect(o.baselineTokens).toEqual(["permit"]);
    expect(o.baselineTokens).not.toContain("book");
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
