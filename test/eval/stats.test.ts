import { describe, expect, it } from "vitest";
import { minimumDetectableEffect, mulberry32, pairedBootstrap } from "./stats";

describe("mulberry32", () => {
  it("is deterministic and uniform in [0, 1)", () => {
    const a = mulberry32(7), b = mulberry32(7);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(mulberry32(8)()).not.toBe(mulberry32(7)());
  });
});

describe("pairedBootstrap", () => {
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `q${i}`);

  it("a constant positive delta has an interval strictly above zero", () => {
    const ci = pairedBootstrap(Array(60).fill(0.1), keys(60));
    expect(ci.mean).toBeCloseTo(0.1, 12);
    expect(ci.lo).toBeCloseTo(0.1, 12);
    expect(ci.hi).toBeCloseTo(0.1, 12);
  });

  it("symmetric noise has an interval that spans zero", () => {
    const deltas = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.5 : -0.5));
    const ci = pairedBootstrap(deltas, keys(200));
    expect(ci.lo).toBeLessThan(0);
    expect(ci.hi).toBeGreaterThan(0);
  });

  it("is reproducible for the same seed and differs for another", () => {
    const deltas = Array.from({ length: 100 }, (_, i) => (i % 7) / 10 - 0.2);
    expect(pairedBootstrap(deltas, keys(100))).toEqual(pairedBootstrap(deltas, keys(100)));
    expect(pairedBootstrap(deltas, keys(100), { seed: 1 }).lo).not.toBe(pairedBootstrap(deltas, keys(100)).lo);
  });

  it("clustering widens the interval when clustered queries move together", () => {
    const deltas = Array.from({ length: 100 }, (_, i) => (Math.floor(i / 10) % 2 ? 0.4 : -0.4));
    const independent = pairedBootstrap(deltas, keys(100));
    const clustered = pairedBootstrap(deltas, deltas.map((_, i) => `c${Math.floor(i / 10)}`));
    expect(clustered.hi - clustered.lo).toBeGreaterThan(independent.hi - independent.lo);
    expect(clustered.clusters).toBe(10);
  });

  it("rejects misaligned input and handles empty input", () => {
    expect(() => pairedBootstrap([1, 2], ["a"])).toThrow(/align/);
    expect(pairedBootstrap([], [])).toEqual({ mean: 0, lo: 0, hi: 0, n: 0, clusters: 0 });
  });
});

describe("minimumDetectableEffect", () => {
  it("is 2.8 * sd / sqrt(n)", () => {
    const deltas = [0.5, -0.5, 0.5, -0.5];
    const sd = Math.sqrt(4 * 0.25 / 3);
    expect(minimumDetectableEffect(deltas)).toBeCloseTo(2.8 * sd / 2, 10);
    expect(minimumDetectableEffect([0.1])).toBe(0);
  });
});

describe("pairedBootstrap statistical correctness (known answers, seeded)", () => {
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `q${i}`);

  it("identical variants (all-zero deltas) give a zero-width interval at 0", () => {
    const ci = pairedBootstrap(Array(300).fill(0), keys(300));
    expect(ci).toEqual({ mean: 0, lo: 0, hi: 0, n: 300, clusters: 300 });
  });

  it("matches the analytic normal interval: mean +/- 1.96 * sd / sqrt(n)", () => {
    // 100 ones and 100 zeros: mean 0.5, sd ~ 0.5013, se ~ 0.0354, half-width ~ 0.0694.
    const deltas = Array.from({ length: 200 }, (_, i) => (i % 2 ? 1 : 0));
    const ci = pairedBootstrap(deltas, keys(200));
    const se = Math.sqrt((0.25 * 200) / 199) / Math.sqrt(200);
    expect(ci.mean).toBeCloseTo(0.5, 12);
    expect(ci.lo).toBeCloseTo(0.5 - 1.96 * se, 1);
    expect(ci.hi).toBeCloseTo(0.5 + 1.96 * se, 1);
  });

  it("cluster resampling matches the analytic interval over cluster means", () => {
    // 20 clusters of 10 queries each; cluster means alternate 0.2 / 0.6 (plug-in sd of means 0.2).
    const deltas = Array.from({ length: 200 }, (_, i) => (Math.floor(i / 10) % 2 ? 0.6 : 0.2));
    const ci = pairedBootstrap(deltas, deltas.map((_, i) => `c${Math.floor(i / 10)}`));
    const se = 0.2 / Math.sqrt(20); // the bootstrap uses the plug-in (1/n) variance
    expect(ci.mean).toBeCloseTo(0.4, 12);
    expect(ci.hi - ci.lo).toBeGreaterThan(2 * 1.96 * se * 0.85);
    expect(ci.hi - ci.lo).toBeLessThan(2 * 1.96 * se * 1.1);
  });

  it("a zero-mean null excludes zero about 5% of the time, not more", () => {
    const rand = mulberry32(123);
    let excluded = 0;
    const trials = 300;
    for (let t = 0; t < trials; t++) {
      const deltas = Array.from({ length: 100 }, () => rand() - 0.5);
      const ci = pairedBootstrap(deltas, keys(100), { iterations: 400, seed: t + 1 });
      if (ci.lo > 0 || ci.hi < 0) excluded++;
    }
    expect(excluded / trials).toBeLessThan(0.1);
  });

  it("a real shift (mean 0.1, noise +/- 0.25) is detected: interval above zero", () => {
    const rand = mulberry32(9);
    const deltas = Array.from({ length: 300 }, () => 0.1 + (rand() - 0.5) / 2);
    expect(pairedBootstrap(deltas, keys(300)).lo).toBeGreaterThan(0);
  });
});
