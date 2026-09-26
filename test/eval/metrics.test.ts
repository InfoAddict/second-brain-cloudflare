import { describe, expect, it } from "vitest";
import { gapKey, mean, mrrAtK, ndcgAtK, percentile, recallAtK, scoreQuery, summarize } from "./metrics";
import type { GoldRef, QueryResult } from "./types";

const gold: GoldRef[] = [{ id: "a", grade: 2 }, { id: "b", grade: 1 }];

describe("metrics", () => {
  it("recall@k is the fraction of gold ids in the first k unique results", () => {
    expect(recallAtK(["x", "a", "y"], gold, 5)).toBe(0.5);
    expect(recallAtK(["x", "a", "y"], gold, 1)).toBe(0);
    expect(recallAtK(["a", "a", "b"], gold, 2)).toBe(1); // duplicates collapse
    expect(recallAtK(["a"], [], 5)).toBe(0);
  });

  it("MRR@k is the reciprocal rank of the first gold id, zero past k", () => {
    expect(mrrAtK(["x", "b", "a"], gold, 10)).toBe(0.5);
    expect(mrrAtK(["x", "y", "a"], gold, 2)).toBe(0);
  });

  it("nDCG@k uses gain 2^grade - 1 and the ideal ordering of the gold set", () => {
    // ranked [b, x, a]: DCG = 1/log2(2) + 3/log2(4) = 2.5; ideal = 3/log2(2) + 1/log2(3)
    const ideal = 3 + 1 / Math.log2(3);
    expect(ndcgAtK(["b", "x", "a"], gold, 10)).toBeCloseTo(2.5 / ideal, 10);
    expect(ndcgAtK(["a", "b"], gold, 10)).toBeCloseTo(1, 10);
    expect(ndcgAtK(["x"], gold, 10)).toBe(0);
  });

  it("scoreQuery returns all four headline metrics", () => {
    expect(scoreQuery(["a", "b"], gold)).toEqual({ recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 });
  });

  it("percentile is nearest-rank and mean of empty is 0", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(mean([])).toBe(0);
  });

  it("summarize reports rows_read as null unless every query measured it", () => {
    const base = (rows: number | null): QueryResult => ({
      queryId: "q", category: "rare-word", clusterKey: "q", rankedIds: [],
      metrics: { recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 },
      cost: { d1Statements: 8, d1RowsRead: rows, aiCalls: 1, embeddingCalls: 1, vectorizeQueries: 1, kvReads: 1, neurons: 2, neuronsEstimated: rows === null, wallMs: 10 },
      leaked: [],
    });
    expect(summarize([base(100), base(300)]).overall.d1RowsRead).toEqual({ mean: 200, p50: 100, p95: 300 });
    expect(summarize([base(100), base(null)]).overall.d1RowsRead).toBeNull();
    expect(summarize([base(1)]).byCategory["rare-word"]?.n).toBe(1);
    expect(summarize([base(100), base(null)]).overall.estimatedNeuronQueries).toBe(1);
  });

  it("summarize counts degraded queries overall and per category", () => {
    const q = (id: string, degraded?: string[]): QueryResult => ({
      queryId: id, category: id === "c" ? "cjk" : "rare-word", clusterKey: id, rankedIds: [],
      metrics: { recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 },
      cost: { d1Statements: 1, d1RowsRead: 1, aiCalls: 0, embeddingCalls: 0, vectorizeQueries: 0, kvReads: 0, neurons: 0, neuronsEstimated: false, wallMs: 1 },
      leaked: [], degraded,
    });
    const s = summarize([q("a", ["semantic-unavailable"]), q("b", []), q("c", ["fts-error"]), q("d")]);
    expect(s.overall.degraded).toBe(2);
    expect(s.byCategory["rare-word"]?.degraded).toBe(1);
    expect(s.byCategory.cjk?.degraded).toBe(1);
  });
});

describe("known-gap split", () => {
  const res = (queryId: string, category: QueryResult["category"], recall5: number, tags?: string[]): QueryResult => ({
    queryId, category, clusterKey: queryId, rankedIds: [], leaked: [], ...(tags && { tags }),
    metrics: { recall5, recall10: recall5, mrr10: recall5, ndcg10: recall5 },
    cost: { d1Statements: 1, d1RowsRead: null, aiCalls: 0, embeddingCalls: 0, vectorizeQueries: 0, kvReads: 0, neurons: 0, neuronsEstimated: false, wallMs: 1 },
  });

  it("keys on the known-gap tag and the gap: prefix only", () => {
    expect(gapKey(undefined)).toBeNull();
    expect(gapKey(["tenancy"])).toBeNull();
    expect(gapKey(["known-gap"])).toBe("known-gap");
    expect(gapKey(["known-gap", "gap:T-0072"])).toBe("gap:T-0072");
    expect(gapKey(["router-budget", "gap:T-0073"])).toBe("gap:T-0073");
    expect(gapKey(["router-budget"])).toBeNull(); // the gap: value is what keys it
  });

  it("keeps known-gap queries out of the headline and each category, and reports them on their own", () => {
    const s = summarize([
      res("a", "identifier", 1), res("b", "identifier", 1),
      res("c", "identifier", 0, ["known-gap", "gap:T-0072"]),
      res("d", "common-word", 0, ["gap:T-0073", "router-budget"]),
      res("e", "common-word", 1),
    ]);
    expect(s.overall.n).toBe(3);
    expect(s.byCategory.identifier?.n).toBe(2);
    expect(s.byCategory.identifier?.metrics.recall5).toBe(1);
    expect(s.byCategory["common-word"]?.n).toBe(1);
    expect(s.knownGaps.overall?.n).toBe(2);
    expect(s.knownGaps.byGap["gap:T-0072"]?.n).toBe(1);
    expect(s.knownGaps.byGap["gap:T-0073"]?.metrics.recall5).toBe(0);
    expect(s.allQueries.n).toBe(5);
    expect(s.allQueries.metrics.recall5).toBeCloseTo(3 / 5);
  });

  it("has no known-gap block when nothing is tagged, and drops a category holding only gap queries from the headline", () => {
    const s = summarize([res("a", "cjk", 1)]);
    expect(s.knownGaps).toEqual({ overall: null, byGap: {} });
    expect(s.allQueries.n).toBe(1);
    const only = summarize([res("a", "cjk", 0, ["known-gap"])]);
    expect(only.byCategory.cjk).toBeUndefined();
    expect(only.knownGaps.byGap["known-gap"]?.n).toBe(1);
  });
});
