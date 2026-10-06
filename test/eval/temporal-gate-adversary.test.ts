// T-0089.2.6 adversary round: each probe runs the REAL evaluateGate on the RECORDED baseline, the exact comparison
// C6 will run, so a wrong candidate that only passed against a plan-oracle reference (or against a baseline that
// had not yet excluded deprecated rows) cannot hide here. Findings fed back into the corpus, the transforms and
// gate.ts's floors (see SYNTHETIC-CORPORA.md, "T-0089.2.6 adversary round"); kept as a permanent part of the suite.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSyntheticCorpus } from "./corpus/synthetic";
import { evaluateGate } from "./gate";
import {
  beliefTimeAsOf, currentOracle, currentOracleNoRestore, demoteNewest, dropOwnTimeline, onlyCategory, oracleBeliefFirst,
  oracleBeliefsUnderTarget, oracleWithoutBeliefs, planOracle, staleDemote, type Transform,
} from "./temporal-transforms";
import { scoreQuery } from "./metrics";
import type { VariantReport } from "./types";

const baseline: VariantReport = JSON.parse(readFileSync(resolve(import.meta.dirname, "data/recorded/temporal.bge-small-en-v1.5.json"), "utf8"));
const corpus = buildSyntheticCorpus("temporal");
const byId = new Map(corpus.entries.map(e => [e.id, e] as const));
const qById = new Map(corpus.queries.map(q => [q.id, q] as const));
const BOOTSTRAP = { iterations: 10_000 } as const; // 14-t2-time-spec.md 6.5's production default.
const gate = (target: "temporal-during" | "knowledge-update", cand: VariantReport, extra = {}) =>
  evaluateGate(baseline, cand, { targetCategories: [target], bootstrap: BOOTSTRAP, allowUnmeasuredRowsRead: true, floors: corpus.floors, ...extra });
const cand = (t: Transform) => t(baseline, corpus);
const show = (r: ReturnType<typeof evaluateGate>) => `${r.verdict} | ${r.rules.map(x => `${x.rule}=${x.status}: ${x.detail}`).join(" || ")}`;

// Production-feasible, zero as-of logic: the loader deprecates retracted rows (C6 replay does applyStatus), and
// release/v4 recall already hides deprecated rows. Nothing else changes.
const dropDeprecatedOnly: Transform = (report) => ({
  ...report,
  results: report.results.map(r => {
    const q = qById.get(r.queryId)!;
    const rankedIds = r.rankedIds.filter(id => byId.get(id)?.retractedAt === undefined);
    return { ...r, rankedIds, metrics: scoreQuery(rankedIds, q.gold, q.forbidden) };
  }),
});

describe("adversary: what the C6 gate (vs the recorded baseline) accepts", () => {
  it("F1: spec row 12, belief-time as-of, must FAIL against the recorded baseline", () => {
    const r = gate("temporal-during", cand(onlyCategory("temporal-during", beliefTimeAsOf)));
    console.log("F1", show(r));
    expect(r.verdict).toBe("FAIL");
  });
  it("F2: spec row 9, belief ranked first, must FAIL against the recorded baseline", () => {
    const r = gate("temporal-during", cand(onlyCategory("temporal-during", oracleBeliefFirst)));
    console.log("F2", show(r));
    expect(r.verdict).toBe("FAIL");
  });
  it("F3: spec KU-2, no D-RET restore, must FAIL against the recorded baseline", () => {
    const r = gate("knowledge-update", cand(onlyCategory("knowledge-update", currentOracleNoRestore)));
    console.log("F3", show(r));
    expect(r.verdict).toBe("FAIL");
  });
  it("F4: an implementation with NO as-of logic (only deprecated rows hidden) must not PASS --target temporal-during", () => {
    const r = gate("temporal-during", cand(dropDeprecatedOnly));
    console.log("F4", show(r));
    expect(r.verdict).not.toBe("PASS");
  });
  it("F5: T-0089.2.3's target subset ku-silent must have headroom to show a win", () => {
    const rows = baseline.results.filter(r => r.tags?.includes("subset:ku-silent"));
    const mrr = rows.reduce((s, r) => s + r.metrics.mrr10, 0) / rows.length;
    console.log("F5 ku-silent n", rows.length, "baseline mrr10", mrr);
    expect(mrr).toBeLessThan(0.95);
  });
  it("F6: baseline per-subset means (report)", () => {
    const acc = new Map<string, number[]>();
    for (const r of baseline.results) for (const t of (r.tags ?? []).filter(x => x.startsWith("subset:"))) { const k = `${r.category} ${t}`; acc.set(k, [...(acc.get(k) ?? []), r.metrics.mrr10]); }
    console.log("F6", [...acc].map(([k, v]) => `${k} n=${v.length} mrr=${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)}`).join("\n"));
  });
});

describe("adversary: D-RET in as-of is ungated against the recorded baseline", () => {
  it("F7: as-of WITHOUT the D-RET restore (old stays closed by bad) must FAIL --target temporal-during", () => {
    const r = gate("temporal-during", cand(onlyCategory("temporal-during", currentOracleNoRestore)));
    console.log("F7", show(r));
    expect(r.verdict).toBe("FAIL");
  });
});

// T-0089.2.6 adversary round 3: KU-4's PASS turned out to depend on clusterKey, an eval-only grouping (the query's
// own timeline instance) that B6's real code cannot compute -- ku-silent has no supersede edge by design, so
// production has no way to know a rival exists at all. A "right" transform used to decide a ship default
// (proof-matrix rows marked PASS: 1, 2, 3, KU-1, KU-4) must read only fields B6's real code can see; clusterKey
// (directly, or through the timelineEntries helper) may appear only in a transform demonstrating a WRONG
// candidate, where reading test-only structure is fine because the candidate is never shipped.
describe("adversary round 3: ship-decision transforms read only production fields", () => {
  const SHIP_DECISION: readonly [string, Transform][] = [
    ["planOracle (row 1, KU-1's currentOracle)", planOracle],
    ["oracleWithoutBeliefs (row 2)", oracleWithoutBeliefs],
    ["oracleBeliefsUnderTarget (row 3)", oracleBeliefsUnderTarget],
    ["staleDemote (KU-4)", staleDemote],
  ];
  const WRONG: readonly [string, Transform][] = [
    ["demoteNewest (row 5)", demoteNewest],
    ["dropOwnTimeline (row 14)", dropOwnTimeline],
    ["oracleBeliefFirst (row 9)", oracleBeliefFirst],
    ["currentOracleNoRestore (row 12, KU-2)", currentOracleNoRestore],
  ];
  const readsClusterKey = (t: Transform) => /clusterKey|timelineEntries/.test(t.toString());

  it.each(SHIP_DECISION)("%s reads no clusterKey or timelineEntries", (_name, t) => {
    expect(readsClusterKey(t)).toBe(false);
  });
  it("currentOracle is exactly planOracle (KU-1 uses the same production-feasible transform as row 1)", () => {
    expect(currentOracle).toBe(planOracle);
  });
  it.each(WRONG)("%s is allowed to (and does) read clusterKey or timelineEntries, as a WRONG candidate", (_name, t) => {
    expect(readsClusterKey(t)).toBe(true);
  });
});
