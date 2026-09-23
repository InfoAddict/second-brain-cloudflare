import { describe, expect, it } from "vitest";
import { DEFAULT_GATE, evaluateGate, formatGate } from "./gate";
import { QUERY_CATEGORIES, RUNNER_VERSION, type QueryResult, type VariantReport } from "./types";

function report(name: string, tweak: (i: number, r: QueryResult) => void = () => {}, n = 240): VariantReport {
  return {
    schema: 1, variant: name, corpus: "core-1k", embeddingModel: "m", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: RUNNER_VERSION, dataFingerprint: { "queries.jsonl": "h" },
    results: Array.from({ length: n }, (_, i) => {
      const r: QueryResult = {
        queryId: `q${i}`, category: QUERY_CATEGORIES[i % QUERY_CATEGORIES.length], clusterKey: `q${i}`, rankedIds: [],
        metrics: { recall5: 0.5, recall10: 0.5, mrr10: 0.5, ndcg10: 0.5 },
        cost: { d1Statements: 8, d1RowsRead: 1000, aiCalls: 1, embeddingCalls: 1, vectorizeQueries: 1, kvReads: 1, neurons: 2, neuronsEstimated: false, wallMs: 50 },
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

  it("FAILs on a degraded query in the candidate", () => {
    const result = evaluateGate(base, report("v", (i, r) => { if (i === 3) r.degraded = ["semantic-unavailable"]; }));
    expect(result.verdict).toBe("FAIL");
    expect(status(result, "degraded")).toBe("fail");
  });

  it("FAILs when the baseline is degraded, so a broken baseline cannot flatter a candidate", () => {
    const result = evaluateGate(report("baseline", (i, r) => { if (i === 3) r.degraded = ["vectorize-filter-unfiltered"]; }), report("v", shift(0.5, 30)));
    expect(result.verdict).toBe("FAIL");
    expect(status(result, "degraded")).toBe("fail");
  });

  it("is INCONCLUSIVE when top-k or runner version differ", () => {
    for (const tweak of [(r: VariantReport) => { r.topK = 5; }, (r: VariantReport) => { r.runnerVersion = RUNNER_VERSION + 1; }]) {
      const cand = report("v");
      tweak(cand);
      expect(status(evaluateGate(base, cand), "comparable")).toBe("inconclusive");
    }
  });

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

  it("FAILs a leak or an error row even when the sample is too small to judge", () => {
    const fewBase = report("b", clustered(4), 200);
    const leaky = report("v", (i, r) => { clustered(4)(i, r); if (i === 5) r.leaked = ["stranger-1"]; }, 200);
    const leakResult = evaluateGate(fewBase, leaky);
    expect(leakResult.verdict).toBe("FAIL");
    expect(status(leakResult, "isolation")).toBe("fail");
    const broken = report("v", (i, r) => { clustered(4)(i, r); if (i === 9) r.error = "boom"; }, 200);
    const errResult = evaluateGate(fewBase, broken);
    expect(errResult.verdict).toBe("FAIL");
    expect(status(errResult, "errors")).toBe("fail");
    const tiny = evaluateGate(report("b", () => {}, 100), report("v", (i, r) => { if (i === 5) r.leaked = ["stranger-1"]; }, 100));
    expect(tiny.verdict).toBe("FAIL");
  });

  describe("targeted-category cluster power", () => {
    // 210 queries in 30 clusters overall; the first 14 are paraphrase queries, all in one cluster unless spread.
    const targeted = (spread: boolean, gain = 0.0625) => {
      const others = QUERY_CATEGORIES.filter(c => c !== "paraphrase");
      const shape = (i: number, r: QueryResult) => {
        r.category = i < 14 ? "paraphrase" : others[i % others.length];
        r.clusterKey = i < 14 ? (spread ? `p${i}` : "p") : `c${i % 29}`;
      };
      const b = report("b", shape, 210);
      const c = report("v", (i, r) => { shape(i, r); if (i < 14) r.metrics.recall10 += gain; }, 210);
      return evaluateGate(b, c, { targetCategories: ["paraphrase"] });
    };

    it("cannot PASS on a targeted gain from one cluster; INCONCLUSIVE names the category and cluster count", () => {
      const result = targeted(false);
      const target = result.deltas.find(d => d.scope === "paraphrase (target)" && d.metric === "recall10")!;
      expect(target.ci.mean).toBe(0.0625);
      expect(result.verdict).toBe("INCONCLUSIVE");
      expect(rule(result, "improvement")?.status).toBe("inconclusive");
      expect(rule(result, "improvement")?.detail).toMatch(/paraphrase.*1 cluster/);
    });

    it("FAILs as a no-op, not INCONCLUSIVE, when an underpowered target has no qualifying gain", () => {
      const result = targeted(false, 0);
      expect(rule(result, "improvement")?.status).toBe("fail");
      expect(result.verdict).toBe("FAIL");
      expect(targeted(false, 0.03125).verdict).toBe("FAIL"); // gain below the 0.05 target margin
    });

    it("still PASSes when the targeted gain spans enough clusters", () => {
      const result = targeted(true);
      expect(result.verdict).toBe("PASS");
      expect(rule(result, "improvement")?.detail).toMatch(/paraphrase recall10/);
    });
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

describe("evaluateGate: errors on either side", () => {
  it("FAILs when the BASELINE errored, so an all-errored baseline cannot flatter a candidate", () => {
    const brokenBase = report("baseline", (_i, r) => { r.error = "replay cache miss"; r.metrics = { recall5: 0, recall10: 0, mrr10: 0, ndcg10: 0 }; });
    const result = evaluateGate(brokenBase, report("v", shift(0.5, 30)));
    expect(status(result, "errors")).toBe("fail");
    expect(result.verdict).toBe("FAIL");
  });
});

describe("evaluateGate: comparability of golden data and limits", () => {
  const fp = (v: string) => ({ "queries.jsonl": v, "needles.jsonl": "n1" });
  const withFp = (name: string, v: string, tweak: (i: number, r: QueryResult) => void = () => {}) => ({ ...report(name, tweak), dataFingerprint: fp(v) });

  it("is INCONCLUSIVE when the golden-data fingerprints differ, even if every query id matches", () => {
    const result = evaluateGate(withFp("b", "h1"), withFp("v", "h2", shift(0.5, 30)));
    expect(status(result, "comparable")).toBe("inconclusive");
    expect(result.verdict).toBe("INCONCLUSIVE");
  });

  it("is INCONCLUSIVE when only one side carries a fingerprint", () => {
    expect(evaluateGate(withFp("b", "h1"), report("v", shift(0.5, 30))).verdict).toBe("INCONCLUSIVE");
  });

  it("compares equal fingerprints (key order irrelevant) and two fingerprint-less reports", () => {
    const a = withFp("b", "h1");
    const b = { ...withFp("v", "h1", shift(0.5, 30)), dataFingerprint: { "needles.jsonl": "n1", "queries.jsonl": "h1" } };
    expect(evaluateGate(a, b).verdict).toBe("PASS");
    const bare = (name: string, tweak?: (i: number, r: QueryResult) => void) => { const { dataFingerprint: _x, ...rest } = { ...report(name, tweak), corpus: "scratch" }; return rest as VariantReport; };
    expect(evaluateGate(bare("b"), bare("v", shift(0.5, 30))).verdict).toBe("PASS"); // non-core corpus: a fingerprint is optional
  });

  it("requires a fingerprint on both reports for a core corpus, saying which one is missing", () => {
    const strip = (r: VariantReport) => { const { dataFingerprint: _x, ...rest } = r; return rest as VariantReport; };
    const good = report("v", shift(0.5, 30));
    const neither = evaluateGate(strip(report("b")), strip(good));
    expect(neither.verdict).toBe("INCONCLUSIVE");
    const detail = neither.rules.find(r => r.rule === "comparable")!.detail;
    expect(detail).toMatch(/baseline.*fingerprint/i);
    expect(detail).toMatch(/candidate.*fingerprint/i);
    const one = evaluateGate(report("b"), strip(good)).rules.find(r => r.rule === "comparable")!.detail;
    expect(one).toMatch(/candidate.*fingerprint/i);
    expect(one).not.toMatch(/baseline.*fingerprint/i);
  });

  it("is INCONCLUSIVE when both reports came from a stale runner, not just when they disagree", () => {
    const stale = (name: string, tweak?: (i: number, r: QueryResult) => void) => ({ ...report(name, tweak), runnerVersion: RUNNER_VERSION - 1 });
    const result = evaluateGate(stale("b"), stale("v", shift(0.5, 30)));
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.rules.find(r => r.rule === "comparable")!.detail).toMatch(/stale/);
  });

  it("is INCONCLUSIVE when either report was limited", () => {
    const good = report("v", shift(0.5, 30));
    expect(status(evaluateGate({ ...report("b"), limit: 250 }, good), "comparable")).toBe("inconclusive");
    expect(status(evaluateGate(report("b"), { ...good, limit: 250 }), "comparable")).toBe("inconclusive");
  });

  it("still FAILs a limited run that leaks: hard invariants come first", () => {
    const leaky = { ...report("v", (i, r) => { if (i === 2) r.leaked = ["x"]; }), limit: 250 };
    expect(evaluateGate(report("b"), leaky).verdict).toBe("FAIL");
  });
});

describe("evaluateGate: known gaps", () => {
  const GAP = ["known-gap", "gap:T-0072"];
  const set = (r: QueryResult, v: number) => { r.metrics = { recall5: v, recall10: v, mrr10: v, ndcg10: v }; };
  // Gap queries are corpus-conditional (corpus/audit.ts): a gap can score 0 at one scale and 1 at another,
  // so the gate reads the baseline score in THIS report instead of trusting the tag.
  const gapN = 20;
  const inGap = (i: number) => i < gapN;
  const gapBase = (baseScore: number, extra: (i: number, r: QueryResult) => void = () => {}) => report("baseline", (i, r) => {
    if (inGap(i)) { r.tags = GAP; set(r, baseScore); }
    extra(i, r);
  });
  const gapCand = (gapScore: number, extra: (i: number, r: QueryResult) => void = () => {}) => report("v", (i, r) => {
    if (inGap(i)) { r.tags = GAP; set(r, gapScore); }
    extra(i, r);
  });

  it("does not let an undeclared gap fix count as an improvement", () => {
    const result = evaluateGate(gapBase(0), gapCand(1));
    expect(status(result, "improvement")).toBe("fail");
    expect(result.deltas.some(d => d.scope.startsWith("gap:"))).toBe(false);
  });

  it("PASSes a declared target-gap fix, and reports the gap's own power", () => {
    const result = evaluateGate(gapBase(0), gapCand(1), { targetGaps: ["T-0072"] });
    expect(result.verdict).toBe("PASS");
    const detail = result.rules.find(r => r.rule === "improvement")!.detail;
    expect(detail).toMatch(/gap:T-0072/);
    expect(detail).toMatch(/n=20/);
    expect(detail).toMatch(/20 clusters/);
  });

  it("does not PASS a declared gap when the gap did not improve", () => {
    expect(status(evaluateGate(gapBase(0), gapCand(0), { targetGaps: ["T-0072"] }), "improvement")).toBe("fail");
  });

  it("is INCONCLUSIVE, not a silent pass, when a declared gap matches no query", () => {
    const result = evaluateGate(gapBase(0), gapCand(1), { targetGaps: ["T-9999"] });
    expect(status(result, "target-gaps")).toBe("inconclusive");
    expect(result.verdict).not.toBe("PASS");
  });

  it("protects gap queries the baseline already answers: a drop fails regression with or without a declaration", () => {
    // gap queries scored 0.5 in the baseline (e.g. a scale-conditional gap at core-1k); the candidate drops them to 0
    const b = gapBase(0.5), c = gapCand(0);
    expect(status(evaluateGate(b, c), "regression")).toBe("fail");
    expect(status(evaluateGate(b, c, { targetGaps: ["T-0072"] }), "regression")).toBe("fail");
  });

  it("does not count a protected gap query's gain as an overall improvement", () => {
    // gap queries the baseline answers at 0.5 rise to 1; the 220 real queries do not move
    const result = evaluateGate(gapBase(0.5), gapCand(1));
    expect(status(result, "regression")).toBe("pass");
    expect(status(result, "improvement")).toBe("fail");
    expect(result.verdict).toBe("FAIL");
  });

  it("leaves gap queries the baseline scores 0 out of the regression population, so they cannot dilute it", () => {
    const result = evaluateGate(gapBase(0), gapCand(0, shift(0.5, 60)));
    const overall = result.deltas.find(d => d.scope === "overall" && d.metric === "recall10")!;
    expect(overall.base).toBeCloseTo(0.5); // 220 real queries, not 240 with 20 constant zeros
  });

  it("G1: a declared gap's wins never mask a regression among the real queries of the same category", () => {
    // 38 identifier queries lose 0.1; 12 gap:T-0072 identifier queries go 0 -> 1
    const shape = (i: number, r: QueryResult, gap: boolean) => {
      if (i < 12) { r.category = "identifier"; r.tags = GAP; set(r, gap ? 1 : 0); }
      else if (i < 50) { r.category = "identifier"; set(r, gap ? 0.8 : 0.9); }
      else { r.category = "rare-word"; set(r, 0.9); }
    };
    const b = report("baseline", (i, r) => shape(i, r, false), 300);
    const c = report("v", (i, r) => shape(i, r, true), 300);
    for (const opts of [{}, { targetGaps: ["T-0072"] }]) {
      const result = evaluateGate(b, c, opts);
      expect(status(result, "regression"), JSON.stringify(opts)).toBe("fail");
      expect(result.rules.find(r => r.rule === "regression")!.detail).toMatch(/identifier/);
      expect(result.verdict).toBe("FAIL");
    }
  });

  it("G1b: gap gains are never averaged into the overall or category deltas", () => {
    const result = evaluateGate(gapBase(0), gapCand(1), { targetGaps: ["T-0072"] });
    const overall = result.deltas.find(d => d.scope === "overall" && d.metric === "recall10")!;
    expect(overall.ci.mean).toBeCloseTo(0);
  });

  it("G2/G3: a declared gap below the category floors is INCONCLUSIVE with the power stated, never a PASS", () => {
    const small = (score: number) => (i: number, r: QueryResult) => { if (i < 8) { r.tags = ["known-gap", "gap:T-0074"]; r.category = "short-word"; set(r, score); } };
    const result = evaluateGate(report("baseline", small(0)), report("v", small(0.5)), { targetGaps: ["T-0074"] });
    expect(status(result, "improvement")).toBe("inconclusive");
    expect(result.verdict).toBe("INCONCLUSIVE");
    const detail = result.rules.find(r => r.rule === "improvement")!.detail;
    expect(detail).toMatch(/gap:T-0074/);
    expect(detail).toMatch(/8 queries in 8 clusters/);
    expect(detail).toMatch(/floor/);
  });

  it("holds a declared gap to the same cluster floor as a category: 12 queries in 2 clusters is inconclusive", () => {
    const few = (score: number) => (i: number, r: QueryResult) => { if (i < 12) { r.tags = GAP; r.clusterKey = `k${i % 2}`; set(r, score); } };
    const result = evaluateGate(report("baseline", few(0)), report("v", few(1)), { targetGaps: ["T-0072"] });
    expect(status(result, "improvement")).toBe("inconclusive");
  });

  it("keeps leaks, errors, and degradation in gap queries as hard failures", () => {
    const leak = evaluateGate(gapBase(0), gapCand(0, (i, r) => { if (i === 1) r.leaked = ["x"]; }));
    expect(status(leak, "isolation")).toBe("fail");
    const err = evaluateGate(gapBase(0), gapCand(0, (i, r) => { if (i === 1) r.error = "boom"; }));
    expect(status(err, "errors")).toBe("fail");
    const deg = evaluateGate(gapBase(0), gapCand(0, (i, r) => { if (i === 1) r.degraded = ["semantic-unavailable"]; }));
    expect(status(deg, "degraded")).toBe("fail");
  });

  it("keeps cost across ALL queries: a cost blowup confined to gap queries still fails", () => {
    const heavy = gapCand(0, (i, r) => { if (inGap(i)) r.cost.neurons = 2 + 400; });
    expect(status(evaluateGate(gapBase(0), heavy), "cost")).toBe("fail");
  });

  it("is INCONCLUSIVE when the two reports disagree about which queries are gaps, including a second gap id", () => {
    const c = report("v", (i, r) => { if (i < 5) r.tags = GAP; });
    expect(status(evaluateGate(gapBase(0), c), "comparable")).toBe("inconclusive");
    const extraId = report("v", (i, r) => { if (inGap(i)) r.tags = [...GAP, "gap:T-0073"]; });
    expect(status(evaluateGate(gapBase(0), extraId), "comparable")).toBe("inconclusive");
  });
});
