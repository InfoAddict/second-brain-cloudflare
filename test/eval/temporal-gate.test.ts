import { describe, expect, it } from "vitest";
import { buildSyntheticCorpus } from "./corpus/synthetic";
import { MONTH_DAY_CONTROL_ACCEPTANCE_MRR } from "./corpus/synthetic-temporal";
import { evaluateGate } from "./gate";
import { scoreQuery } from "./metrics";
import { simulate } from "./temporal-oracle";
import { RUNNER_VERSION, type CostSample, type GoldRef, type GoldenQuery, type QueryResult, type VariantReport } from "./types";

// Re-scores the real temporal corpus under hand-built rankings, the way the round-3 adversary re-scored recorded
// candidates: no model calls (fast, deterministic), but real gold, real validity data, and the real gate.

const corpus = buildSyntheticCorpus("temporal");
const byId = new Map(corpus.entries.map(e => [e.id, e] as const));
const cost: CostSample = { d1Statements: 15, d1RowsRead: null, aiCalls: 1, embeddingCalls: 1, vectorizeQueries: 1, kvReads: 1, neurons: 1, neuronsEstimated: false, wallMs: 10 };
const FEW = { bootstrap: { iterations: 500 } } as const;

/** The id of a timeline's sibling document, from a "during"-subset query's own tags and clusterKey. */
const sibling = (q: GoldenQuery, suffix: string): string => {
  const kind = q.tags!.find(t => t.startsWith("timeline:"))!.slice("timeline:".length);
  const i = q.clusterKey!.replace("tm-", "");
  return `tm-${kind}-${i}-${suffix}`;
};

/**
 * A plausible "today" ranking: gold-first for current-state and prefiltered questions, empty for phrase-dated and the
 * month-day controls (matching the shipped parser's real behavior on both), and a distinct pattern per "during"
 * subset chosen to exercise both directions: phrase-vague and retracted-past start off confused (the wrong sibling
 * ranked first, as today's belief-time confusion looks); backdated-past starts off correct, so a regression is
 * visible when something makes it worse.
 */
function baselineRanked(q: GoldenQuery): string[] {
  const tag = (name: string) => q.tags?.includes(`subset:${name}`);
  if (tag("phrase-dated") || tag("control-not-asof")) return [];
  if (tag("phrase-vague")) return [sibling(q, "new"), sibling(q, "old")];
  if (tag("backdated-past")) return [sibling(q, "new"), sibling(q, "old"), sibling(q, "recap")];
  if (tag("retracted-past")) return [sibling(q, "bad"), sibling(q, "old")];
  return q.gold.map(g => g.id);
}

function toResult(q: GoldenQuery, rankedIds: string[]): QueryResult {
  return { queryId: q.id, category: q.category, clusterKey: q.clusterKey ?? q.id, tags: q.tags, rankedIds, leaked: [], metrics: scoreQuery(rankedIds, q.gold), cost };
}

function report(variant: string, rank: (q: GoldenQuery) => string[]): VariantReport {
  return {
    schema: 1, variant, corpus: "temporal", embeddingModel: "m", d1Backend: "sqlite", isolate: "warm", topK: 10,
    runnerVersion: RUNNER_VERSION, dataFingerprint: corpus.dataFingerprint,
    results: corpus.queries.map(q => toResult(q, rank(q))),
  };
}

const baseline = report("baseline", baselineRanked);

describe("temporal-during isolates Track 2's as-of gate from phrase-dated and the month-day controls", () => {
  it("the supersession oracle passes --target temporal-during", () => {
    const candidate = report("supersession", q => simulate("supersession", baselineRanked(q), q, byId));
    const result = evaluateGate(baseline, candidate, { ...FEW, targetCategories: ["temporal-during"] });
    expect(result.rules.find(r => r.rule === "regression")!.status).toBe("pass");
    const improvement = result.rules.find(r => r.rule === "improvement")!;
    expect(improvement.status).toBe("pass");
    expect(improvement.detail).toMatch(/temporal-during (recall10|mrr10) \+/);
  });

  it("a recency-only reorder does not pass --target temporal-during: it regresses the backdated timelines", () => {
    const candidate = report("recency", q => simulate("recency", baselineRanked(q), q, byId));
    const result = evaluateGate(baseline, candidate, { ...FEW, targetCategories: ["temporal-during"] });
    expect(result.verdict).toBe("FAIL");
    expect(result.rules.find(r => r.rule === "regression")!.status).toBe("fail");
    expect(result.rules.find(r => r.rule === "regression")!.detail).toMatch(/temporal-during/);
  });

  it("deleting the date parser passes the old, unsplit temporal category but not temporal-during: why the category was split", () => {
    const candidate = report("deleted-parser", q => (q.tags?.includes("subset:phrase-dated") ? q.gold.map(g => g.id) : baselineRanked(q)));
    const onOldCategory = evaluateGate(baseline, candidate, { ...FEW, targetCategories: ["temporal"] });
    const oldImprovement = onOldCategory.rules.find(r => r.rule === "improvement")!;
    expect(oldImprovement.status).toBe("pass");
    expect(oldImprovement.detail).toMatch(/temporal (recall10|mrr10) \+/);
    const onDuring = evaluateGate(baseline, candidate, { ...FEW, targetCategories: ["temporal-during"] });
    expect(onDuring.rules.find(r => r.rule === "regression")!.status).toBe("pass");
    expect(onDuring.rules.find(r => r.rule === "improvement")!.detail).not.toMatch(/temporal-during/);
  });
});

describe("retracted-past gold no longer rewards ranking the cancelled move first", () => {
  const q = corpus.queries.find(x => x.tags?.includes("subset:retracted-past"))!;
  const cancelledMoveFirst = [sibling(q, "bad"), sibling(q, "old")];

  it("scores the cancelled-move-first ranking at 0.5 MRR against the actually-true gold, not 1.0", () => {
    expect(scoreQuery(cancelledMoveFirst, q.gold).mrr10).toBeCloseTo(0.5, 5);
  });

  it("would have scored 1.0 under the round-2 dual-grade gold (bad included): the false pass this round removes", () => {
    const oldGold: GoldRef[] = [{ id: sibling(q, "old"), grade: 2 }, { id: sibling(q, "bad"), grade: 1 }];
    expect(scoreQuery(cancelledMoveFirst, oldGold).mrr10).toBe(1);
  });
});

describe("the month-day control gap: a mechanical pass is not the same as meeting the acceptance floor", () => {
  const controlRanked = (mrr1Count: number) => {
    let seen = 0;
    return (q: GoldenQuery) => {
      if (!q.tags?.includes("subset:control-not-asof")) return baselineRanked(q);
      seen++;
      return seen <= mrr1Count ? q.gold.map(g => g.id) : [];
    };
  };
  const targetGaps = ["temporal-month-day-controls"];
  const gapRow = (result: ReturnType<typeof evaluateGate>) => result.deltas.find(d => d.scope === "gap:temporal-month-day-controls (target)" && d.metric === "mrr10")!;

  it("a correct parser meets both the mechanical target-gaps rule and the documented floor", () => {
    const candidate = report("correct-parser", controlRanked(30));
    const result = evaluateGate(baseline, candidate, { ...FEW, targetGaps });
    expect(result.rules.find(r => r.rule === "improvement")!.detail).toMatch(/gap:temporal-month-day-controls (recall10|mrr10) \+/);
    expect(gapRow(result).candidate).toBeGreaterThanOrEqual(MONTH_DAY_CONTROL_ACCEPTANCE_MRR);
  });

  it("a parser that only fixes 60 percent of the controls still passes the mechanical rule: the floor is a manual check gate.ts cannot express on a delta alone", () => {
    const candidate = report("misreading-parser", controlRanked(18)); // 18/30 = 0.60, the figure quoted in the review
    const result = evaluateGate(baseline, candidate, { ...FEW, targetGaps });
    expect(result.rules.find(r => r.rule === "improvement")!.detail).toMatch(/gap:temporal-month-day-controls (recall10|mrr10) \+/);
    expect(gapRow(result).candidate).toBeCloseTo(0.6, 5);
    expect(gapRow(result).candidate).toBeLessThan(MONTH_DAY_CONTROL_ACCEPTANCE_MRR);
  });

  it("a still-broken parser shows no gain and does not pass", () => {
    const candidate = report("still-broken", controlRanked(0));
    const result = evaluateGate(baseline, candidate, { ...FEW, targetGaps });
    expect(result.rules.find(r => r.rule === "improvement")!.detail).not.toMatch(/gap:temporal-month-day-controls/);
  });

  it("none of the three parser candidates move temporal-during: the controls stay isolated from the as-of gate", () => {
    for (const [name, count] of [["correct", 30], ["misreading", 18], ["broken", 0]] as const) {
      const candidate = report(name, controlRanked(count));
      const result = evaluateGate(baseline, candidate, { ...FEW, targetCategories: ["temporal-during"] });
      expect(result.rules.find(r => r.rule === "regression")!.status).toBe("pass");
      expect(result.rules.find(r => r.rule === "improvement")!.detail).not.toMatch(/temporal-during/);
    }
  });
});
