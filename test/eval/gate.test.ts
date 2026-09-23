import { describe, expect, it } from "vitest";
import { mulberry32 } from "./stats";
import { DEFAULT_GATE, evaluateGate, formatGate } from "./gate";
import { QUERY_CATEGORIES, type QueryResult, type VariantReport } from "./types";

function report(name: string, tweak: (i: number, r: QueryResult) => void = () => {}, n = 240): VariantReport {
  return {
    schema: 1, variant: name, corpus: "core-1k", embeddingModel: "m", d1Backend: "sqlite", isolate: "warm",
    results: Array.from({ length: n }, (_, i) => {
      const r: QueryResult = {
        queryId: `q${i}`, category: QUERY_CATEGORIES[i % QUERY_CATEGORIES.length], clusterKey: `q${i}`, rankedIds: [],
        metrics: { recall5: 0.5, recall10: 0.5, mrr10: 0.5, ndcg10: 0.5 },
        cost: { d1Statements: 8, d1RowsRead: 1000, aiCalls: 1, embeddingCalls: 1, vectorizeQueries: 1, kvReads: 1, neurons: 2, wallMs: 50 },
        leaked: [],
      };
      tweak(i, r);
      return r;
    }),
  };
}
const shift = (delta: number, upTo: number) => (i: number, r: QueryResult) => {
  if (i < upTo) for (const k of Object.keys(r.metrics) as (keyof QueryResult["metrics"])[]) r.metrics[k] = Math.min(1, Math.max(0, r.metrics[k] + delta));
};
const status = (result: ReturnType<typeof evaluateGate>, rule: string) => result.rules.find(r => r.rule === rule)?.status;

describe("evaluateGate", () => {
  const base = report("baseline");

  it("PASSes a clear improvement with no regression and no extra cost", () => {
    const result = evaluateGate(base, report("v", shift(0.5, 30)), { allowUnmeasuredRowsRead: false });
    expect(result.verdict).toBe("PASS");
  });

  it("FAILs a no-op: nothing improved", () => {
    const result = evaluateGate(base, report("noop"));
    expect(status(result, "improvement")).toBe("fail");
    expect(status(result, "regression")).toBe("pass");
    expect(result.verdict).toBe("FAIL");
  });

  it("FAILs a regression of 0.01 or more even when another metric improves", () => {
    const cand = report("v", (i, r) => {
      if (i < 12) r.metrics.recall10 -= 0.5; // -0.025 mean
      if (i >= 100 && i < 140) r.metrics.ndcg10 += 0.5; // +0.083 mean
    });
    const result = evaluateGate(base, cand);
    expect(status(result, "regression")).toBe("fail");
    expect(result.verdict).toBe("FAIL");
  });

  it("FAILs a significant regression smaller than the tolerance", () => {
    const cand = report("v", (i, r) => { if (i < 200) r.metrics.mrr10 -= 0.004; });
    expect(status(evaluateGate(base, cand), "regression")).toBe("fail");
  });

  it("FAILs when one category loses more than its tolerance while the overall mean improves", () => {
    const cand = report("v", (i, r) => {
      if (r.category === "cjk") r.metrics.recall10 -= 0.3;
      else if (i < 120) r.metrics.recall10 += 0.3;
    });
    const result = evaluateGate(base, cand);
    expect(result.rules.find(r => r.rule === "regression")?.detail).toMatch(/cjk/);
    expect(result.verdict).toBe("FAIL");
  });

  it("accepts a targeted gain only when the variant declared that category", () => {
    // +0.06 on 30 paraphrase queries: overall recall@10 moves 0.0075 (under the 0.02 margin).
    const cand = report("v", (_i, r) => { if (r.category === "paraphrase") r.metrics.recall10 += 0.06; });
    expect(status(evaluateGate(base, cand), "improvement")).toBe("fail");
    expect(status(evaluateGate(base, cand, { targetCategories: ["paraphrase"] }), "improvement")).toBe("pass");
  });

  it("FAILs any cross-workspace leak, however good the metrics", () => {
    const cand = report("v", (i, r) => { shift(0.5, 30)(i, r); if (i === 5) r.leaked = ["stranger-1"]; });
    const result = evaluateGate(base, cand);
    expect(status(result, "isolation")).toBe("fail");
    expect(result.verdict).toBe("FAIL");
  });

  it("FAILs when the candidate errors on more queries than the baseline", () => {
    const cand = report("v", (i, r) => { shift(0.5, 30)(i, r); if (i === 9) r.error = "boom"; });
    expect(status(evaluateGate(base, cand), "errors")).toBe("fail");
  });

  it("is INCONCLUSIVE below the power floor, and on mismatched corpora or query sets", () => {
    expect(evaluateGate(report("b", () => {}, 100), report("v", shift(0.5, 30), 100)).verdict).toBe("INCONCLUSIVE");
    const other = { ...report("v", shift(0.5, 30)), corpus: "scale-5k" };
    expect(evaluateGate(base, other).verdict).toBe("INCONCLUSIVE");
    const shorter = report("v", shift(0.5, 30), 239);
    expect(evaluateGate(base, shorter).verdict).toBe("INCONCLUSIVE");
  });

  it("enforces the cost budget", () => {
    const heavy = (over: Partial<QueryResult["cost"]>) => report("v", (i, r) => { shift(0.5, 30)(i, r); Object.assign(r.cost, over); });
    expect(status(evaluateGate(base, heavy({ neurons: 2 + 26 })), "cost")).toBe("fail");
    expect(status(evaluateGate(base, heavy({ neurons: 2 + 25 })), "cost")).toBe("pass");
    expect(status(evaluateGate(base, heavy({ d1Statements: 8 + 3 })), "cost")).toBe("fail");
    expect(status(evaluateGate(base, heavy({ aiCalls: 3 })), "cost")).toBe("fail");
    expect(status(evaluateGate(base, heavy({ d1RowsRead: 1400 })), "cost")).toBe("fail");
    expect(status(evaluateGate(base, heavy({ d1Statements: 60 })), "cost")).toBe("fail"); // p95 ceiling
  });

  it("treats unmeasured rows_read as INCONCLUSIVE unless explicitly allowed", () => {
    const unmeasured = (v: string, up: number) => report(v, (i, r) => { shift(0.5, up)(i, r); r.cost.d1RowsRead = null; });
    const b = unmeasured("b", 0), c = unmeasured("c", 30);
    expect(evaluateGate(b, c).verdict).toBe("INCONCLUSIVE");
    const allowed = evaluateGate(b, c, { allowUnmeasuredRowsRead: true });
    expect(status(allowed, "cost")).toBe("pass");
    expect(allowed.verdict).toBe("PASS");
  });

  it("is direction-sensitive: swapping baseline and candidate flips a PASS into a FAIL", () => {
    const better = report("v", shift(0.5, 30));
    expect(evaluateGate(base, better).verdict).toBe("PASS");
    expect(evaluateGate(better, base).verdict).toBe("FAIL");
  });

  it("formats a readable summary and freezes the default thresholds", () => {
    const text = formatGate(evaluateGate(base, report("v", shift(0.5, 30))));
    expect(text).toMatch(/PASS/);
    expect(text).toMatch(/recall10/);
    expect(Object.isFrozen(DEFAULT_GATE)).toBe(true);
  });
});

describe("evaluateGate statistical correctness (known outcomes, seeded)", () => {
  const base = report("baseline");

  it("identical variants can never PASS", () => {
    const result = evaluateGate(base, report("same"));
    expect(result.verdict).toBe("FAIL");
    expect(status(result, "improvement")).toBe("fail");
    expect(result.deltas.every(d => d.ci.lo === 0 && d.ci.hi === 0)).toBe(true);
  });

  it("a known large improvement PASSes with a lower bound above zero", () => {
    const result = evaluateGate(base, report("v", shift(0.5, 60)));
    expect(result.verdict).toBe("PASS");
    const row = result.deltas.find(d => d.scope === "overall" && d.metric === "recall10")!;
    expect(row.ci.mean).toBeCloseTo(0.125, 10);
    expect(row.ci.lo).toBeGreaterThan(0);
  });

  it("a known regression FAILs", () => {
    const result = evaluateGate(base, report("v", shift(-0.4, 60)));
    expect(result.verdict).toBe("FAIL");
    expect(status(result, "regression")).toBe("fail");
  });

  it("zero-mean paired noise passes at most rarely, and only on a real sample gain", () => {
    // 240 queries, sd 0.115: a +0.02 sample mean is ~2.7 sigma, so a fluke is possible but rare.
    let passes = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rand = mulberry32(seed);
      const noisy = report("v", (_i, r) => {
        const d = (rand() - 0.5) * 0.4;
        for (const k of Object.keys(r.metrics) as (keyof QueryResult["metrics"])[]) r.metrics[k] += d;
      });
      const result = evaluateGate(base, noisy);
      if (result.verdict !== "PASS") continue;
      passes++;
      const row = result.deltas.find(d => d.scope === "overall" && d.metric === "recall10")!;
      expect(row.ci.mean).toBeGreaterThanOrEqual(0.02);
      expect(row.ci.lo).toBeGreaterThan(0);
    }
    expect(passes).toBeLessThanOrEqual(2);
  }, 60_000);
});

describe("evaluateGate boundaries", () => {
  const base = report("baseline", () => {}, 200);

  it("a headline drop of exactly the tolerance fails on the point estimate alone", () => {
    // recall@10 deltas: 50 x +0.25, 50 x -0.25, 4 x -0.5, rest 0: mean exactly -2/200 = -0.01,
    // and the noise keeps the interval spanning zero, so only the tolerance rule can fire.
    const cand = report("v", (i, r) => {
      if (i < 50) r.metrics.recall10 += 0.25;
      else if (i < 100) r.metrics.recall10 -= 0.25;
      else if (i < 104) r.metrics.recall10 -= 0.5;
    }, 200);
    const result = evaluateGate(base, cand);
    const row = result.deltas.find(d => d.scope === "overall" && d.metric === "recall10")!;
    expect(row.ci.mean).toBe(-0.01);
    expect(row.ci.hi).toBeGreaterThan(0);
    expect(result.rules.find(r => r.rule === "regression")?.detail).toMatch(/overall recall10/);
  });

  it("a gain whose interval bottoms out at exactly zero is not an improvement", () => {
    // All the gain sits in 1 of 4 clusters, so about 32% of resamples miss it and lo is exactly 0.
    const cand = report("v", (i, r) => {
      r.clusterKey = `c${i % 4}`;
      if (i % 4 === 0) for (const k of ["recall10", "mrr10", "ndcg10"] as const) r.metrics[k] += 0.5;
    }, 200);
    const result = evaluateGate(base, cand);
    const row = result.deltas.find(d => d.scope === "overall" && d.metric === "recall10")!;
    expect(row.ci.mean).toBeGreaterThanOrEqual(0.02);
    expect(row.ci.lo).toBe(0);
    expect(status(result, "improvement")).toBe("fail");
  });
});
