import { describe, expect, it } from "vitest";
import { chooseThreshold, scoreFiring, summarizeInput, wilson, type StandingProbe } from "./standing";

const probe = (group: StandingProbe["group"], split: StandingProbe["split"], expected: string[], scores: [string, number][]): StandingProbe =>
  ({ group, split, expected: new Set(expected), scores: scores.map(([id, value]) => ({ id, value })).sort((a, b) => b.value - a.value) });

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
  });
});
