// CALIBRATION RECORD (Task 11)
//
// Threshold sign-off (plan Step 7 / Decision 6): decided by the orchestrator on Rahil's delegation, Sep 24 2026.
// DEFAULT_GATE stands as provisional-then-approved: headline regression 0.01, improvement margin 0.02, target margin
// 0.05, minClusters 30, minCategoryClusters 10, with two rule changes made from the measurements below:
//  1. A category regression must lose STRICTLY MORE than one query's worth, max(0.03, 1/n); a single flipped query in a
//     small category never fails the gate on its own (scale-20k long-context, q-long-006: -1/24). The losers list in
//     --compare still names it.
//  2. When no improvement is shown and the comparison's MDE for a metric exceeds the improvement margin, the improvement
//     rule is INCONCLUSIVE ("underpowered: MDE x > margin y"), not FAIL; a true no-op (MDE about 0) still FAILs. This
//     replaces the plan's "MDE <= 0.0133" criterion: MDE is a property of each comparison's paired deltas (near 0 when
//     nothing changes, 0.05-0.065 when a comparison has real effects), not of the query set, so no query-set size can
//     satisfy that criterion for an arbitrary variant.
// MDE estimator (Sep 24 2026 review fixes): MDE = 2.8 x the standard error (SD of the replicates) of the SAME cluster
// bootstrap that draws the interval, so unit (whole clusters) and weighting (clusters count by their queries) match; an
// equal-weight cluster-mean formula understated a two-query-cluster gain (0.0144 vs 0.026) and could FAIL where the
// bootstrap says INCONCLUSIVE.
// Golden-set expansion (T-0043.6): 299 -> 1,433 clusters (338 -> 1,586 queries), weighted to the target categories:
// paraphrase 48 -> 440, multi-hop 30 -> 150, long-context 24 -> 220. Recall@10 MDE on the regression population, core-1k,
// old (299 clusters) -> new (`node scripts/eval-run-ts.mjs test/eval/mde-table.ts` prints every category):
//   like->baseline 0.0000 -> 0.0022 (a true tie);  baseline->dense-only 0.0568 -> 0.0351;  ->keyword-only 0.0486 -> 0.0189;
//   ->sabotage 0.0513 -> 0.0299; like->baseline at scale-5k 0.0568 -> 0.0240 and at scale-20k 0.0587 -> 0.0248;
//   mild changes (MMR_LAMBDA 0.6, RECENCY_FLOOR 0.5), the ~0.02-sized effects a reranker or contextual embeddings are
//   expected to have: 0.0202 -> 0.0144 and 0.0083 -> 0.0127.
// Per category (the target-category rule asks for +0.05 with a lower bound above zero, so it needs MDE <= 0.05 there):
//   paraphrase 0.180 (dense-only, old) -> 0.055 / 0.051 (dense-only / keyword-only) and 0.030, 0.029 on mild changes;
//   long-context 0.230 -> 0.054 / 0.038 and 0.013-0.018 on mild changes; multi-hop 0.024 / 0.023 and about 0.009.
// The MDE belongs to the comparison (the spread of its paired deltas), not to the query set, so it did not fall by
// sqrt(clusters): the large ablations move many more lexical queries now, which raises their own spread. Honest limit: a
// comparison that moves nearly every paraphrase query (an ablation of a whole arm) sits at about 0.05 in that category, so a
// +0.05 target gain is at the edge of detectability there; a reranker that moves a fraction of the queries is well inside it.
// Measured (core-1k, the 5k/20k like-vs-baseline runs, quality-only): see docs/superpowers/eval-results/DISCRIMINATION.md.
//
// Golden labels: the Task 6c step 9 20-query spot check is DONE, as a Codex blind pass (step 9b): 17/20 exact and 3
// graded-gold ambiguities; labels trustworthy (gw notes on T-0043.2). Not owed again.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { ReplayStore, makeReplayAi } from "./ai-replay";
import { CORE_DATA_DIR, buildCorpus } from "./corpus/build";
import { loadCorpus } from "./corpus/loader";
import { evaluateGate, findLosers } from "./gate";
import { replayPaths } from "./corpora";
import { runVariant } from "./runner";
import type { VariantReport } from "./types";
import { getVariant, registerVariant, unregisterVariant } from "./variants";

// Each gate evaluation resamples 1,256 queries 10,000 times per metric and category; a loaded machine needs the room.
vi.setConfig({ testTimeout: 30_000 });

const MODEL = DEFAULTS.EMBEDDING_MODEL;
const COMMITTED = resolve(CORE_DATA_DIR, `replay.${MODEL.split("/").pop()}.jsonl.gz`);
// read lists only files that exist (the committed layer plus any local cache), so this is what the runs below replay from.
const cache = replayPaths(MODEL, "core-1k").read;

// A skipIf on the cache would silently skip everything below on a checkout without it (a green run that tested
// nothing). Task 9 commits the layer, so its absence is a failure, not a skip.
it("the committed core replay layer is present", () => {
  expect(existsSync(COMMITTED), `${COMMITTED} missing: Task 9 Step 12 must be committed before Task 11`).toBe(true);
});

const rule = (r: ReturnType<typeof evaluateGate>, name: string) => r.rules.find(x => x.rule === name)!;

// A deliberately broken recall: the keyword arm keeps one candidate and MMR ignores relevance.
const SABOTAGE = "sabotage";

describe("gate calibration on core-1k (offline)", () => {
  const reports: Record<string, VariantReport> = {};

  registerVariant({ name: SABOTAGE, description: "Calibration only: KEYWORD_CANDIDATE_LIMIT 1 and MMR_LAMBDA 0.", config: { KEYWORD_CANDIDATE_LIMIT: 1, MMR_LAMBDA: 0, RERANK_MODE: "off" } });
  afterAll(() => unregisterVariant(SABOTAGE));

  beforeAll(async () => {
    const spec = buildCorpus("core-1k");
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore(cache), mode: "replay" }), embeddingModel: MODEL });
    try {
      for (const name of ["baseline", "baseline-again", "like", "dense-only", "keyword-only", SABOTAGE]) {
        const variant = getVariant(name === "baseline" || name === "baseline-again" ? "no-rerank" : name);
        reports[name] = await runVariant({ corpus, variant, queries: spec.queries, isolate: "warm", embeddingModel: MODEL });
      }
    } finally {
      await corpus.close();
    }
  }, 1_800_000);

  it("is deterministic: the same variant twice ranks every query identically", () => {
    expect(reports["baseline-again"].results.map(r => r.rankedIds)).toEqual(reports.baseline.results.map(r => r.rankedIds));
  });

  it("a no-op fails only for want of an improvement", () => {
    const gate = evaluateGate(reports.baseline, reports["baseline-again"], { allowUnmeasuredRowsRead: true });
    expect(rule(gate, "improvement").status).toBe("fail");
    for (const name of ["isolation", "errors", "degraded", "regression", "cost"]) expect(rule(gate, name).status, name).toBe("pass");
  });

  it("dense-only (keyword arm removed) is caught, and the failure names identifier or rare-word", () => {
    const gate = evaluateGate(reports.baseline, reports["dense-only"], { allowUnmeasuredRowsRead: true });
    expect(gate.verdict).toBe("FAIL");
    expect(rule(gate, "regression").detail).toMatch(/identifier|rare-word/);
  });

  it("keyword-only (dense arm removed) is caught, and the failure names paraphrase", () => {
    const gate = evaluateGate(reports.baseline, reports["keyword-only"], { allowUnmeasuredRowsRead: true });
    expect(gate.verdict).toBe("FAIL");
    expect(rule(gate, "regression").detail).toMatch(/paraphrase/);
  });

  it("like vs baseline on core-1k barely differs, because 1k rows never truncate LIKE's 500-row window", () => {
    const gate = evaluateGate(reports.like, reports.baseline, { allowUnmeasuredRowsRead: true });
    const overall = gate.deltas.find(d => d.scope === "overall" && d.metric === "recall10")!;
    expect(Math.abs(overall.ci.mean)).toBeLessThan(0.02);
    expect(rule(gate, "improvement").status).toBe("fail"); // MDE about 0: a real tie, not an underpowered one
  });

  it("has the clusters the expansion promised, and realistic comparisons are powered to about 0.02", () => {
    const gate = evaluateGate(reports.baseline, reports["keyword-only"], { allowUnmeasuredRowsRead: true });
    const overall = gate.deltas.find(d => d.scope === "overall" && d.metric === "recall10")!;
    expect(overall.ci.clusters).toBeGreaterThanOrEqual(1400);
    // measured 0.0195 (was 0.0486 on the 299-cluster set)
    expect(gate.mde.recall10!).toBeLessThan(0.025);
    // the target categories can prove a +0.05 gain (MDE at most 0.05) when a variant moves part of them; measured 0.0514 and 0.0379
    const categoryMde = (scope: string) => 2.8 * gate.deltas.find(d => d.scope === scope && d.metric === "recall10")!.ci.se;
    expect(categoryMde("multi-hop")).toBeLessThan(0.05);
    expect(categoryMde("long-context")).toBeLessThan(0.05);
    expect(categoryMde("paraphrase")).toBeLessThan(0.06);
    // an ablation that moves most queries is not a realistic comparison: report its MDE, do not pretend it reaches 0.02
    expect(evaluateGate(reports.baseline, reports["dense-only"], { allowUnmeasuredRowsRead: true }).mde.recall10!).toBeGreaterThan(0.025);
  });

  it("a deliberately sabotaged variant fails the regression rule", () => {
    const gate = evaluateGate(reports.baseline, reports[SABOTAGE], { allowUnmeasuredRowsRead: true });
    expect(gate.verdict).toBe("FAIL");
    expect(rule(gate, "regression").status).toBe("fail");
    for (const name of ["isolation", "errors", "degraded"]) expect(rule(gate, name).status, name).toBe("pass");
  });

  it("no variant leaks across workspaces or errors", () => {
    for (const [name, r] of Object.entries(reports)) {
      expect(r.results.flatMap(x => x.leaked), name).toEqual([]);
      expect(r.results.filter(x => x.error), name).toEqual([]);
      expect(r.results.filter(x => x.degraded?.length), name).toEqual([]); // degraded is a hard invariant, FAIL on either side
    }
  });
});

// scale-5k and scale-20k caches are local (.eval-cache, never committed), so these run on demand:
//   EVAL_SCALE=1 npx vitest run test/eval/calibration.test.ts
// They are the discrimination table: would this eval have approved the 3.6.0 FTS release (like -> baseline)?
describe.runIf(process.env.EVAL_SCALE)("discrimination at scale: like vs baseline (local caches)", () => {
  const scaled: Record<string, { like: VariantReport; baseline: VariantReport }> = {};

  beforeAll(async () => {
    for (const id of ["scale-5k", "scale-20k"] as const) {
      const spec = buildCorpus(id);
      const read = replayPaths(MODEL, id).read;
      const corpus = await loadCorpus({ spec, backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore(read), mode: "replay" }), embeddingModel: MODEL });
      try {
        const run = (name: string) => runVariant({ corpus, variant: getVariant(name), queries: spec.queries, isolate: "warm", embeddingModel: MODEL });
        scaled[id] = { like: await run("like"), baseline: await run("baseline") };
      } finally {
        await corpus.close();
      }
    }
  }, 7_200_000);

  const cell = (id: string, scope: string, metric: "recall10" | "mrr10") =>
    evaluateGate(scaled[id].like, scaled[id].baseline, { allowUnmeasuredRowsRead: true }).deltas.find(d => d.scope === scope && d.metric === metric)!;

  it.each(["scale-5k", "scale-20k"])("%s: like loses common-word to baseline, significantly (the 500-row window truncates LIKE)", id => {
    const d = cell(id, "common-word", "recall10");
    expect(d.ci.lo).toBeGreaterThan(0);
    expect(d.ci.mean).toBeGreaterThanOrEqual(0.5);
  });

  it.each(["scale-5k", "scale-20k"])("%s: like loses rare-word and identifier to baseline by at least 0.05, lower bound above zero", id => {
    for (const scope of ["rare-word", "identifier"]) {
      const d = cell(id, scope, "recall10");
      expect(d.ci.lo, `${id} ${scope}`).toBeGreaterThan(0);
      expect(d.ci.mean, `${id} ${scope}`).toBeGreaterThanOrEqual(0.05);
    }
  });

  it.each(["scale-5k", "scale-20k"])("%s: the improvement rule passes for baseline over like", id => {
    expect(rule(evaluateGate(scaled[id].like, scaled[id].baseline, { allowUnmeasuredRowsRead: true }), "improvement").status).toBe("pass");
  });

  // Measured on the 1,433-cluster set (T-0043.6): the FTS keyword arm costs a little on the queries it does not help. On the
  // 299-cluster set these losses were inside the noise and the regression rule passed; with 440 paraphrase and 220 long-context
  // clusters they are significant, so the rule FAILs on them. That is the more powered gate telling the truth about the 3.6.0
  // release (FTS won lexical categories by 0.05-0.6 and lost 0.009 paraphrase at 5k, 0.023 long-context at 20k), not a
  // calibration error. The losers are non-lexical queries only: a keyword change cannot make the dense arm worse.
  it.each([["scale-5k", "paraphrase", 0.02], ["scale-20k", "long-context", 0.03]] as const)("%s: the regression rule fails only on a small %s loss", (id, category, bound) => {
    const { like, baseline } = scaled[id];
    const gate = evaluateGate(like, baseline, { allowUnmeasuredRowsRead: true });
    const regression = rule(gate, "regression");
    expect(regression.status).toBe("fail");
    const named = [...regression.detail.matchAll(/([a-z-]+) (?:recall5|recall10|mrr10|ndcg10) (-?[\d.]+)/g)];
    expect(named.length).toBeGreaterThan(0);
    for (const [, scope, value] of named) {
      expect(scope, regression.detail).toBe(category);
      expect(Math.abs(Number(value)), regression.detail).toBeLessThan(bound);
    }
    const losers = findLosers(like, baseline).map(l => l.queryId);
    expect(losers.length).toBeGreaterThan(0);
    for (const queryId of losers) expect(queryId, "only non-lexical queries lose to FTS").toMatch(/^q-(para|long|hop)-/);
  });
});
