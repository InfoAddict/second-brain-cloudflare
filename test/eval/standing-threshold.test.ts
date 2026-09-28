import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { VariantReport } from "./types";

// Committed by Task 2's local prepare/run pass (test/eval/SYNTHETIC-CORPORA.md documents the reproduce commands).
const REPORT_PATH = resolve(import.meta.dirname, "data/baselines/standing.bge-small-en-v1.5.json");

function readReport(): VariantReport {
  return JSON.parse(readFileSync(REPORT_PATH, "utf8")) as VariantReport;
}

describe("standing threshold report", () => {
  it("is committed, with a standing block for the raw and distilled inputs", () => {
    expect(existsSync(REPORT_PATH)).toBe(true);
    const report = readReport();
    expect(report.corpus).toBe("standing");
    expect(report.standing).toBeDefined();
    expect(report.standing!.inputs.raw).toBeDefined();
    expect(report.standing!.inputs.distilled).toBeDefined();
  });

  it("the chosen raw-input threshold is precision-stable at itself and the next two recorded grid steps", () => {
    const raw = readReport().standing!.inputs.raw;
    const at = (t: number) => raw.curve.find(p => Math.abs(p.threshold - t) < 1e-9);
    const chosen = raw.chosen.threshold;
    for (const t of [chosen, Number((chosen + 0.01).toFixed(2)), Number((chosen + 0.02).toFixed(2))]) {
      const point = at(t);
      // Only checked when the step is still inside the committed 0.60-0.80 grid; chooseStableThreshold's own
      // unit tests (test/eval/standing.test.ts) cover the stability rule itself in full, including its edges.
      if (point) expect(point.precision).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("reports both intent-fire treatments, and a clustered test interval at least as wide as the per-query one", () => {
    const raw = readReport().standing!.inputs.raw;
    expect(raw.chosen.intentCountedAsFalsePositive.dev).toBeDefined();
    expect(raw.chosen.intentCountedAsFalsePositive.test).toBeDefined();
    expect(raw.chosen.test.precisionCiClustered[0]).toBeLessThanOrEqual(raw.chosen.test.precisionCi[0]);
    expect(raw.chosen.test.precisionCiClustered[1]).toBeGreaterThanOrEqual(raw.chosen.test.precisionCi[1]);
    expect(raw.chosen.test.recallCiClustered[0]).toBeLessThanOrEqual(raw.chosen.test.recallCi[0]);
    expect(raw.chosen.test.recallCiClustered[1]).toBeGreaterThanOrEqual(raw.chosen.test.recallCi[1]);
  });

  it("the distilled input is unusable (P7.1: raw is the only viable embedding for standing)", () => {
    const distilled = readReport().standing!.inputs.distilled;
    expect(distilled.chosen.test.recall).toBeLessThan(0.2);
  });

  // Wired so a change to either the config value or this committed report, without updating
  // the other, fails.
  it("STANDING_THRESHOLD in DEFAULTS equals the eval's recorded choice for the raw input", async () => {
    const { DEFAULTS } = await import("../../src/config");
    expect(DEFAULTS.STANDING_THRESHOLD).toBe(readReport().standing!.inputs.raw.chosen.threshold);
  });
});
