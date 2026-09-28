import { describe, expect, it } from "vitest";
import { buildSyntheticCorpus } from "./corpus/synthetic";
import { syntheticLines } from "./synthetic-report";
import { RUNNER_VERSION, type CostSample, type QueryResult, type VariantReport } from "./types";

const cost: CostSample = { d1Statements: 1, d1RowsRead: null, aiCalls: 0, embeddingCalls: 0, vectorizeQueries: 0, kvReads: 0, neurons: 0, neuronsEstimated: false, wallMs: 1 };

describe("syntheticLines: temporal forbidden-above-gold (T-0089.2.6)", () => {
  it("prints forbidden above gold per subset, only for queries that declare one", () => {
    const corpus = buildSyntheticCorpus("temporal");
    const forbiddenQuery = corpus.queries.find(q => q.category === "temporal-during" && q.forbidden?.length)!;
    const goldId = forbiddenQuery.gold[0].id, forbiddenId = forbiddenQuery.forbidden![0];
    const subset = forbiddenQuery.tags!.find(t => t.startsWith("subset:"))!.slice("subset:".length);

    const above: QueryResult = { queryId: forbiddenQuery.id, category: "temporal-during", clusterKey: forbiddenQuery.clusterKey!, tags: forbiddenQuery.tags, rankedIds: [forbiddenId, goldId], metrics: { recall5: 0, recall10: 0, mrr10: 0, ndcg10: 0 }, cost, leaked: [] };
    const reportAbove: VariantReport = { schema: 1, variant: "v", corpus: "temporal", embeddingModel: "m", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: RUNNER_VERSION, results: [above] };
    const linesAbove = syntheticLines(reportAbove).join("\n");
    expect(linesAbove).toContain("forbidden above gold, per subset");
    expect(linesAbove).toMatch(new RegExp(`${subset}\\s+1/1`));

    const below: QueryResult = { ...above, rankedIds: [goldId, forbiddenId] };
    const reportBelow: VariantReport = { ...reportAbove, results: [below] };
    expect(syntheticLines(reportBelow).join("\n")).toMatch(new RegExp(`${subset}\\s+0/1`));
  });

  it("prints nothing for a report with no forbidden-bearing query", () => {
    const other: QueryResult = { queryId: "tm-q-control-0", category: "temporal", clusterKey: "tm-control-0", tags: ["subset:control-not-asof"], rankedIds: [], metrics: { recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 }, cost, leaked: [] };
    const report: VariantReport = { schema: 1, variant: "v", corpus: "temporal", embeddingModel: "m", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: RUNNER_VERSION, results: [other] };
    expect(syntheticLines(report).join("\n")).not.toContain("forbidden above gold");
  });
});
