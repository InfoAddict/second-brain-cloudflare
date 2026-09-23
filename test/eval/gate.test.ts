import { describe, expect, it } from "vitest";
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

  it("zero-mean paired noise and sub-margin gains never PASS", () => {
    // Deterministic stand-ins for noise; the seeded 300-dataset null test in stats.test.ts covers the rest.
    const swing = report("swing", (i, r) => { r.metrics.recall10 += i % 2 ? 0.2 : -0.2; });
    expect(evaluateGate(base, swing).verdict).toBe("FAIL");
    const small = report("small", (_i, r) => { r.metrics.recall10 += 0.0125; r.metrics.mrr10 += 0.0125; r.metrics.ndcg10 += 0.0125; });
    const smallResult = evaluateGate(base, small);
    expect(status(smallResult, "improvement")).toBe("fail");
    expect(status(smallResult, "regression")).toBe("pass");
    const mixed = report("mixed", (i, r) => { if (i < 120) r.metrics.recall10 += 0.05; else r.metrics.recall10 -= 0.05; });
    expect(status(evaluateGate(base, mixed), "improvement")).toBe("fail");
  });
});

describe("evaluateGate pairing and cluster validation", () => {
  const base = report("baseline", () => {}, 200);
  const rule = (result: ReturnType<typeof evaluateGate>, name: string) => result.rules.find(r => r.rule === name);
  const clustered = (k: number) => (i: number, r: QueryResult) => { r.clusterKey = `c${i % k}`; };

  it("is INCONCLUSIVE, naming the ID, when a report repeats a query ID (power-floor bypass)", () => {
    const dup = (name: string, gain: number) => {
      const r = report(name, () => {}, 200);
      r.results.forEach(x => { x.queryId = "q0"; x.clusterKey = "q0"; x.metrics.recall10 += gain; x.metrics.mrr10 += gain; x.metrics.ndcg10 += gain; });
      return r;
    };
    const result = evaluateGate(dup("b", 0), dup("v", 0.5));
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(rule(result, "comparable")?.detail).toMatch(/duplicate query IDs.*q0/);
  });

  it("is INCONCLUSIVE when one report holds extra query IDs, naming them", () => {
    const cand = report("v", shift(0.5, 30), 200);
    cand.results[199].queryId = "stray";
    const detail = rule(evaluateGate(base, cand), "comparable")?.detail ?? "";
    expect(detail).toMatch(/q199/);
    expect(detail).toMatch(/stray/);
  });

  it("is INCONCLUSIVE when the candidate relabels clusters (20 clusters presented as 200 independent queries)", () => {
    const honestBase = report("b", clustered(40), 200);
    const gain = (i: number, r: QueryResult) => { clustered(40)(i, r); if (i % 40 < 2) for (const k of ["recall10", "mrr10", "ndcg10"] as const) r.metrics[k] += 0.5; };
    expect(status(evaluateGate(honestBase, report("v", gain, 200)), "improvement")).toBe("fail");
    const relabeled = report("v", (i, r) => { gain(i, r); r.clusterKey = `q${i}`; }, 200);
    const result = evaluateGate(honestBase, relabeled);
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(rule(result, "comparable")?.detail).toMatch(/cluster.*q0/);
  });

  it("is INCONCLUSIVE when a query changes category between reports", () => {
    const cand = report("v", shift(0.5, 30), 200);
    cand.results[3].category = "cjk";
    const result = evaluateGate(base, cand);
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(rule(result, "comparable")?.detail).toMatch(/category.*q3/);
  });

  it("pairs each candidate score with its own baseline query, whatever the row order", () => {
    // Baseline recall@10 alternates 0.75/0.25; candidate is baseline + 0.03125 for every query.
    const hetero = (gain: number) => report("h", (i, r) => { r.metrics.recall10 = (i % 2 ? 0.25 : 0.75) + gain; }, 200);
    const cand = hetero(0.03125);
    for (const order of [cand.results, [...cand.results].reverse()]) {
      const result = evaluateGate(hetero(0), { ...cand, results: order });
      const ci = result.deltas.find(d => d.scope === "overall" && d.metric === "recall10")!.ci;
      expect(ci.mean).toBe(0.03125);
      expect(ci.lo).toBe(0.03125);
      expect(ci.hi).toBe(0.03125);
      expect(status(result, "improvement")).toBe("pass");
    }
  });

  it("is INCONCLUSIVE when the queries fall into too few clusters, even above the query floor", () => {
    const few = (n: number) => report("v", (i, r) => { clustered(n)(i, r); shift(0.5, 60)(i, r); }, 200);
    const fewBase = report("b", clustered(4), 200);
    const result = evaluateGate(fewBase, few(4));
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(rule(result, "power")?.detail).toMatch(/4 distinct clusters/);
    const ok = evaluateGate(report("b", clustered(30), 200), few(30));
    expect(rule(ok, "power")).toBeUndefined();
    expect(ok.verdict).toBe("PASS");
  });
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
    // All the gain sits in 2 of 30 clusters, so about 13% of resamples miss it and lo is exactly 0.
    const cand = report("v", (i, r) => {
      r.clusterKey = `c${i % 30}`;
      if (i % 30 < 2) for (const k of ["recall10", "mrr10", "ndcg10"] as const) r.metrics[k] += 0.5;
    }, 200);
    const baseC = report("b", (i, r) => { r.clusterKey = `c${i % 30}`; }, 200);
    const result = evaluateGate(baseC, cand);
    const row = result.deltas.find(d => d.scope === "overall" && d.metric === "recall10")!;
    expect(row.ci.mean).toBeGreaterThanOrEqual(0.02);
    expect(row.ci.lo).toBe(0);
    expect(status(result, "improvement")).toBe("fail");
  });

  // Gains are dyadic (0.5, 0.25) so the sums are exact and the mean lands on the threshold literal.
  it("an overall gain of exactly +0.0200 passes; just under fails", () => {
    const at = (top: number) => evaluateGate(report("b", (_i, r) => { r.metrics.recall10 = 0; }, 200),
      report("v", (i, r) => { r.metrics.recall10 = i < 7 ? 0.5 : i === 7 ? top : 0; }, 200));
    const exact = at(0.5); // 8 x 0.5 / 200
    expect(exact.deltas.find(d => d.scope === "overall" && d.metric === "recall10")!.ci.mean).toBe(0.02);
    expect(status(exact, "improvement")).toBe("pass");
    expect(status(at(0.48), "improvement")).toBe("fail");
  });

  it("a targeted gain of exactly +0.0500 passes; just under fails", () => {
    // 25 paraphrase queries out of 200; overall recall@10 moves far less than the 0.02 margin.
    const at = (last: number) => {
      let seen = 0;
      return evaluateGate(report("b", (_i, r) => { r.metrics.recall10 = 0; }, 200),
        report("v", (_i, r) => {
          const hit = r.category === "paraphrase" && seen++ < 5;
          r.metrics.recall10 = hit ? (seen === 5 ? last : 0.25) : 0;
        }, 200), { targetCategories: ["paraphrase"] });
    };
    const exact = at(0.25); // 5 x 0.25 / 25
    expect(exact.deltas.find(d => d.scope === "paraphrase (target)" && d.metric === "recall10")!.ci.mean).toBe(0.05);
    expect(status(exact, "improvement")).toBe("pass");
    expect(status(at(0.24), "improvement")).toBe("fail");
  });
});
