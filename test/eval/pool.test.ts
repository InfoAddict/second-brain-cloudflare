import { describe, expect, it } from "vitest";
import { summarize } from "./metrics";
import { poolDiagnostic } from "./runner";
import type { QueryResult } from "./types";

const gold = [{ id: "g", grade: 2 as const }, { id: "root", grade: 1 as const }];

describe("candidate-pool diagnostic", () => {
  it("collapses chunk duplicates and reports whether a grade-2 gold is anywhere in the pool", () => {
    expect(poolDiagnostic(["a", "a", "g", "b"], gold)).toEqual({ size: 3, goldInPool: true, recall30: 1 });
    // a grade-1 gold (the multi-hop root) counts toward neither field
    expect(poolDiagnostic(["a", "root"], gold)).toEqual({ size: 2, goldInPool: false, recall30: 0 });
    expect(poolDiagnostic([], gold)).toEqual({ size: 0, goldInPool: false, recall30: 0 });
  });

  it("keeps goldInPool and recall30 consistent: recall30 never exceeds the share of queries with a gold in the pool", () => {
    const two = [{ id: "a", grade: 2 as const }, { id: "b", grade: 2 as const }];
    const found = poolDiagnostic(["a", "x"], two)!;
    expect(found).toEqual({ size: 2, goldInPool: true, recall30: 0.5 });
    expect(found.recall30 > 0 && !found.goldInPool).toBe(false);
  });

  it("counts only the first 30 pool entries toward recall@30", () => {
    const ids = [...Array.from({ length: 30 }, (_, i) => `x${i}`), "g"];
    expect(poolDiagnostic(ids, [{ id: "g", grade: 2 }])).toMatchObject({ goldInPool: true, recall30: 0 });
  });

  it("is absent when recall reported no candidates, and averaged per group in the summary", () => {
    expect(poolDiagnostic(undefined, gold)).toBeUndefined();
    const result = (queryId: string, pool?: QueryResult["pool"]): QueryResult => ({
      queryId, category: "paraphrase", clusterKey: queryId, rankedIds: [], metrics: { recall5: 0, recall10: 0, mrr10: 0, ndcg10: 0 },
      cost: { d1Statements: 1, d1RowsRead: null, aiCalls: 1, embeddingCalls: 1, vectorizeQueries: 1, kvReads: 0, neurons: 0, neuronsEstimated: false, wallMs: 1 }, leaked: [], ...(pool && { pool }),
    });
    const summary = summarize([result("a", { size: 10, goldInPool: true, recall30: 1 }), result("b", { size: 10, goldInPool: false, recall30: 0 })]);
    expect(summary.overall.pool).toEqual({ goldInPool: 0.5, recall30: 0.5 });
    expect(summarize([result("c")]).overall.pool).toBeUndefined();
  });
});
