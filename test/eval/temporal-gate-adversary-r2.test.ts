// T-0089.2.6 adversary round 2: can a WRONG stale penalty pass T-0089.2.3's ku-silent gate? Findings fed back into
// the corpus (ku-silent-fresh, ku-silent-true) and staleDemote's age/rival check (see SYNTHETIC-CORPORA.md).
// Kept as a permanent part of the suite, alongside round 1's temporal-gate-adversary.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSyntheticCorpus } from "./corpus/synthetic";
import { KU_SILENT_TARGET } from "./corpus/synthetic-temporal";
import { EVAL_NOW } from "./corpus/types";
import { evaluateGate } from "./gate";
import { scoreQuery } from "./metrics";
import { onlyCategory, recencySort, staleDemote, type Transform } from "./temporal-transforms";
import type { VariantReport } from "./types";

const baseline: VariantReport = JSON.parse(readFileSync(resolve(import.meta.dirname, "data/recorded/temporal.bge-small-en-v1.5.json"), "utf8"));
const corpus = buildSyntheticCorpus("temporal");
const byId = new Map(corpus.entries.map(e => [e.id, e] as const));
const qById = new Map(corpus.queries.map(q => [q.id, q] as const));
const staleGate = (t: Transform) => evaluateGate(baseline, onlyCategory("knowledge-update", t)(baseline, corpus), {
  targetCategories: ["knowledge-update"], targetSubsets: [KU_SILENT_TARGET], bootstrap: { iterations: 10_000 }, allowUnmeasuredRowsRead: true, floors: corpus.floors,
});
const show = (r: ReturnType<typeof evaluateGate>) => `${r.verdict} | ${r.rules.filter(x => ["regression", "subset-regression", "corpus-floors", "improvement"].includes(x.rule)).map(x => `${x.rule}=${x.status}: ${x.detail}`).join(" || ")}`;
const demoteWhere = (bad: (id: string) => boolean): Transform => (report) => ({
  ...report,
  results: report.results.map(r => {
    const q = qById.get(r.queryId)!;
    const rankedIds = [...r.rankedIds.filter(id => !bad(id)), ...r.rankedIds.filter(bad)];
    return { ...r, rankedIds, metrics: scoreQuery(rankedIds, q.gold, q.forbidden) };
  }),
});
const DAY = 86_400_000;

describe("adversary r2: the stale-penalty gate cannot tell a right penalty from a wrong one", () => {
  it("R1: a penalty on EVERY volatility:state row, fresh or stale (ignores the 90-day rule), must not PASS", () => {
    // staleDemote itself never checks age; demote a state row created YESTERDAY-fresh and it scores the same.
    const r = staleGate(demoteWhere(id => byId.get(id)?.tags.includes("volatility:state") ?? false));
    const kuSilentOldAges = corpus.entries.filter(e => e.tags.includes("volatility:state")).map(e => Math.round((EVAL_NOW - e.createdAt) / DAY));
    console.log("R1", show(r), "| state rows:", kuSilentOldAges.length, "min age days", Math.min(...kuSilentOldAges));
    expect(r.verdict).not.toBe("PASS");
  });
  it("R2: a wording shortcut (boost 'Heard secondhand'/'may have' hedges) must not PASS the stale target", () => {
    const hedge = (id: string) => /secondhand|may have/.test(byId.get(id)?.content ?? "");
    const r = staleGate(demoteWhere(id => !hedge(id)));
    console.log("R2", show(r));
    expect(r.verdict).not.toBe("PASS");
  });
  it("R3: a plain recency sort must not PASS the stale target", () => {
    const r = staleGate(recencySort);
    console.log("R3", show(r));
    expect(r.verdict).not.toBe("PASS");
  });
  it("R4: the corpus must contain a stale-but-still-true gold, or a stale penalty's harm is unmeasurable", () => {
    const staleTrueGold = corpus.queries.filter(q => q.category === "knowledge-update").flatMap(q => q.gold.map(g => byId.get(g.id)!))
      .filter(e => e.tags.includes("volatility:state") && e.validUntil === undefined);
    console.log("R4 stale-and-true gold in knowledge-update:", staleTrueGold.length, "| staleDemote PASS?", staleGate(staleDemote).verdict);
    expect(staleTrueGold.length).toBeGreaterThan(0);
  });
});
