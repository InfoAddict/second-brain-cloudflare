// T-0089.2.6 adversary round 3: KU-4's PASS used to depend on clusterKey, which production lacks. Fixed by
// removing the clusterKey rival check from staleDemote itself (see SYNTHETIC-CORPORA.md); this probe now shows
// both versions agree, since they are the same transform. Kept as a permanent part of the suite.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSyntheticCorpus } from "./corpus/synthetic";
import { KU_SILENT_TARGET, STALE_THRESHOLD_DAYS } from "./corpus/synthetic-temporal";
import { DAY_MS, EVAL_NOW } from "./corpus/types";
import { evaluateGate } from "./gate";
import { scoreQuery } from "./metrics";
import { onlyCategory, staleDemote, type Transform } from "./temporal-transforms";
import type { VariantReport } from "./types";

const baseline: VariantReport = JSON.parse(readFileSync(resolve(import.meta.dirname, "data/recorded/temporal.bge-small-en-v1.5.json"), "utf8"));
const corpus = buildSyntheticCorpus("temporal");
const byId = new Map(corpus.entries.map(e => [e.id, e] as const));
const qById = new Map(corpus.queries.map(q => [q.id, q] as const));
const staleGate = (t: Transform) => evaluateGate(baseline, onlyCategory("knowledge-update", t)(baseline, corpus), {
  targetCategories: ["knowledge-update"], targetSubsets: [KU_SILENT_TARGET], bootstrap: { iterations: 10_000 }, allowUnmeasuredRowsRead: true, floors: corpus.floors,
});
const show = (r: ReturnType<typeof evaluateGate>) => `${r.verdict} | ${r.rules.filter(x => ["subset-regression", "corpus-floors", "improvement"].includes(x.rule)).map(x => `${x.rule}=${x.status}: ${x.detail}`).join(" || ")}`;

// Exactly staleDemote minus hasRival: what B6 can compute (tag, age, unsuperseded, not deprecated). ku-silent has
// no supersede edge by design, so production has no way to know a rival exists; clusterKey is eval-only grouping.
const productionStaleDemote: Transform = (report) => ({
  ...report,
  results: report.results.map(r => {
    const q = qById.get(r.queryId)!;
    const stale = (id: string) => {
      const e = byId.get(id);
      return !!e && e.tags.includes("volatility:state") && e.validUntil === undefined && e.retractedAt === undefined && (EVAL_NOW - e.createdAt) / DAY_MS >= STALE_THRESHOLD_DAYS;
    };
    const rankedIds = [...r.rankedIds.filter(id => !stale(id)), ...r.rankedIds.filter(stale)];
    return { ...r, rankedIds, metrics: scoreQuery(rankedIds, q.gold, q.forbidden) };
  }),
});

describe("adversary r3: KU-4's verdict must not depend on a feature production lacks", () => {
  it("R5: staleDemote without the clusterKey rival check gets the same verdict as KU-4", () => {
    const withKey = staleGate(staleDemote), without = staleGate(productionStaleDemote);
    console.log("R5 KU-4 (clusterKey):", show(withKey), "\nR5 production-feasible:", show(without));
    expect(without.verdict).toBe(withKey.verdict);
  });
});
