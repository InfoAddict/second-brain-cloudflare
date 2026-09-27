import { describe, expect, it } from "vitest";
import { parseTimePhrase } from "../../src/text/temporal";
import { standing as buildStandingCorpus } from "./corpus/synthetic-standing";
import {
  chooseStableThreshold, chooseThreshold, PRECISION_TARGET, scoreFiring, summarizeInput, THRESHOLD_GRID_FINE, wilson, wilsonClustered,
  type StandingProbe,
} from "./standing";

const probe = (group: StandingProbe["group"], split: StandingProbe["split"], expected: string[], scores: [string, number][], clusterKey?: string): StandingProbe =>
  ({ group, split, expected: new Set(expected), clusterKey: clusterKey ?? expected[0] ?? scores[0]?.[0] ?? "cluster", scores: scores.map(([id, value]) => ({ id, value })).sort((a, b) => b.value - a.value) });

describe("scoreFiring", () => {
  const probes = [
    probe("yes", "dev", ["a"], [["a", 0.8], ["b", 0.6], ["c", 0.5]]),
    probe("unrelated", "dev", [], [["b", 0.75]]),
    probe("yes", "dev", ["c"], [["a", 0.7], ["c", 0.4]]),
    probe("intent", "dev", [], [["a", 0.9]]),
    probe("overlap", "dev", [], [["a", 0.2]]),
  ];

  it("counts wrong fires and missed expected fires, firing at most two memories per query", () => {
    expect(scoreFiring(probes, 0.5)).toMatchObject({ truePositive: 1, falsePositive: 3, falseNegative: 1, precision: 1 / 4, recall: 1 / 2 });
  });

  it("reports same-subject-different-intent fires separately and never counts them in precision", () => {
    const at = scoreFiring(probes, 0.5);
    expect(at.intentFired).toBe(1);
    expect(at.intentQueries).toBe(1);
    expect(scoreFiring(probes.filter(p => p.group !== "intent"), 0.5).precision).toBe(at.precision);
  });

  it("gives precision 0 when nothing fires rather than treating an empty prediction as success", () => {
    expect(scoreFiring(probes, 0.95)).toMatchObject({ precision: 0, recall: 0, truePositive: 0, falseNegative: 2 });
  });

  it("counts an intent fire as a false positive when asked for the other treatment (Q1)", () => {
    const excluded = scoreFiring(probes, 0.5);
    const counted = scoreFiring(probes, 0.5, { countIntentAsFalsePositive: true });
    expect(counted.falsePositive).toBe(excluded.falsePositive + 1);
    expect(counted.precision).toBeLessThan(excluded.precision);
    // The excluded treatment (default) is unaffected by the option existing.
    expect(excluded).toMatchObject({ falsePositive: 3 });
  });
});

describe("threshold choice and intervals", () => {
  const dev = [
    probe("yes", "dev", ["a"], [["a", 0.9]]), probe("yes", "dev", ["a"], [["a", 0.7]]),
    probe("unrelated", "dev", [], [["a", 0.6]]), probe("unrelated", "dev", [], [["a", 0.4]]),
  ];

  it("picks the highest-recall threshold that meets the precision target", () => {
    expect(chooseThreshold(dev, [0.3, 0.5, 0.65, 0.8], 0.9)).toEqual({ threshold: 0.65, meetsPrecisionTarget: true });
  });

  it("falls back to the best F1 and says the target was missed", () => {
    const hard = [probe("yes", "dev", ["a"], [["a", 0.5]]), probe("unrelated", "dev", [], [["a", 0.5]])];
    expect(chooseThreshold(hard, [0.3, 0.5, 0.7], 0.9)).toEqual({ threshold: 0.3, meetsPrecisionTarget: false });
  });

  it("brackets a proportion with a Wilson interval that stays inside 0 to 1", () => {
    const [lo, hi] = wilson(5, 10);
    expect(lo).toBeGreaterThan(0.23); expect(hi).toBeLessThan(0.77);
    expect(wilson(0, 0)).toEqual([0, 1]);
    expect(wilson(10, 10)[1]).toBeLessThanOrEqual(1);
  });

  it("chooses on the dev split and reports the held-out split with intervals", () => {
    const all = [...dev, probe("yes", "test", ["b"], [["b", 0.9]]), probe("unrelated", "test", [], [["b", 0.7]])];
    const report = summarizeInput(all, [0.3, 0.5, 0.65, 0.8], 0.9);
    expect(report.curve).toHaveLength(4);
    expect(report.chosen.threshold).toBe(0.65);
    expect(report.chosen.test).toMatchObject({ truePositive: 1, falsePositive: 1 });
    expect(report.chosen.test.precisionCi).toHaveLength(2);
    expect(report.chosen.test.precisionCiClustered).toHaveLength(2);
    expect(report.chosen.intentCountedAsFalsePositive.test).toBeDefined();
  });
});

describe("THRESHOLD_GRID_FINE", () => {
  it("spans 0.60 to 0.80 in 0.01 steps (C2)", () => {
    expect(THRESHOLD_GRID_FINE[0]).toBe(0.6);
    expect(THRESHOLD_GRID_FINE.at(-1)).toBe(0.8);
    expect(THRESHOLD_GRID_FINE).toHaveLength(21);
    for (let i = 1; i < THRESHOLD_GRID_FINE.length; i++) {
      expect(Number((THRESHOLD_GRID_FINE[i] - THRESHOLD_GRID_FINE[i - 1]).toFixed(2))).toBe(0.01);
    }
  });
});

describe("chooseStableThreshold", () => {
  it("picks the lowest threshold whose precision holds at itself and the next two grid steps on a plain curve", () => {
    // Precision is 0.5 (fails) at 0.5, where the false positive still fires, and 1.0 (holds) from 0.6 onward
    // once it drops out: no cliff, so the plain rule and the stable rule agree.
    const dev = [
      probe("yes", "dev", ["a"], [["a", 0.65]]),
      probe("unrelated", "dev", [], [["a", 0.5]]),
    ];
    expect(chooseStableThreshold(dev, [0.5, 0.6, 0.65, 0.7, 0.75], 0.9)).toEqual({ threshold: 0.6, meetsPrecisionTarget: true });
  });

  it("rejects a one-step spike on the cliff and waits for a threshold that stays stable for two more steps", () => {
    // 15 true positives always present (score 0.95, never drop off the grid); 6 more true positives present
    // only through t = 0.67 (score exactly 0.67). Five false positives: three vanish once t > 0.66, the last
    // two vanish once t > 0.70.
    const dev: StandingProbe[] = [
      ...Array.from({ length: 15 }, (_, i) => probe("yes", "dev", [`base-${i}`], [[`base-${i}`, 0.95]], `base-${i}`)),
      ...Array.from({ length: 6 }, (_, i) => probe("yes", "dev", [`trans-${i}`], [[`trans-${i}`, 0.67]], `trans-${i}`)),
      ...Array.from({ length: 3 }, (_, i) => probe("unrelated", "dev", [], [[`fp-a${i}`, 0.665]], `fp-a${i}`)),
      ...Array.from({ length: 2 }, (_, i) => probe("unrelated", "dev", [], [[`fp-b${i}`, 0.70]], `fp-b${i}`)),
    ];
    // Sanity-check the trap: 0.67 alone meets the target (a one-step spike), but 0.68 does not, so a naive
    // single-point rule would wrongly pick 0.67.
    expect(scoreFiring(dev, 0.67).precision).toBeGreaterThanOrEqual(0.9);
    expect(scoreFiring(dev, 0.68).precision).toBeLessThan(0.9);
    expect(chooseStableThreshold(dev, THRESHOLD_GRID_FINE, PRECISION_TARGET)).toEqual({ threshold: 0.71, meetsPrecisionTarget: true });
  });

  it("falls back to the best F1 and flags the target as missed when no threshold is stable", () => {
    const dev = [probe("yes", "dev", ["a"], [["a", 0.5]]), probe("unrelated", "dev", [], [["a", 0.5]])];
    expect(chooseStableThreshold(dev, [0.3, 0.5, 0.7], 0.9)).toEqual({ threshold: 0.3, meetsPrecisionTarget: false });
  });
});

describe("wilsonClustered", () => {
  it("is at least as wide as the per-query interval when trials outnumber clusters", () => {
    const perQuery = wilson(40, 50);
    const clustered = wilsonClustered(40, 50, 10);
    expect(clustered[0]).toBeLessThanOrEqual(perQuery[0]);
    expect(clustered[1]).toBeGreaterThanOrEqual(perQuery[1]);
  });

  it("matches the per-query interval when every trial is its own cluster", () => {
    expect(wilsonClustered(5, 10, 10)).toEqual(wilson(5, 10));
  });

  it("stays inside 0 to 1 with no clusters", () => {
    expect(wilsonClustered(0, 0, 0)).toEqual([0, 1]);
  });
});

describe("standing corpus queries carry no time phrase", () => {
  it("so recall's semanticQuery equals the literal query text, and the eval's raw input measures production (Task 2 input note)", () => {
    const corpus = buildStandingCorpus(1);
    const standingQueries = corpus.queries.filter(q => q.category === "standing");
    expect(standingQueries.length).toBe(1500);
    for (const q of standingQueries) {
      const { after, before } = parseTimePhrase(q.text, Date.UTC(2026, 0, 1));
      expect(after, `query ${q.id} ("${q.text}") has a time phrase`).toBeUndefined();
      expect(before, `query ${q.id} ("${q.text}") has a time phrase`).toBeUndefined();
    }
  });
});
