import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSyntheticCorpus } from "./corpus/synthetic";
import { fingerprintKey } from "./lock";
import { RUNNER_VERSION, type VariantReport } from "./types";

const RECORDED_PATH = resolve(import.meta.dirname, "data/recorded/temporal.bge-small-en-v1.5.json");
const RECORD_COMMAND = "npm run eval:recall -- --variant baseline --corpus temporal --json test/eval/data/recorded/temporal.bge-small-en-v1.5.json";

describe("recorded temporal baseline (T-0089.2.6, after T-0089.2.5 merged into release/v4)", () => {
  const recorded: VariantReport = JSON.parse(readFileSync(RECORDED_PATH, "utf8"));
  const corpus = buildSyntheticCorpus("temporal");

  it("the recorded report's fingerprint equals the corpus's, or names the re-record command", () => {
    const same = !!recorded.dataFingerprint && !!corpus.dataFingerprint && fingerprintKey(recorded.dataFingerprint) === fingerprintKey(corpus.dataFingerprint);
    expect(same, same ? "" : `recorded fingerprint ${JSON.stringify(recorded.dataFingerprint)} does not match the corpus's ${JSON.stringify(corpus.dataFingerprint)}; re-record with: ${RECORD_COMMAND}`).toBe(true);
  });

  it("recorded on sqlite, runnerVersion 8, no errors", () => {
    expect(recorded.d1Backend).toBe("sqlite");
    expect(recorded.runnerVersion).toBe(RUNNER_VERSION);
    expect(recorded.results.filter(r => r.error)).toEqual([]);
    expect(recorded.results.length).toBeGreaterThan(0);
  });

  it("is a recorded baseline, not a lock: pre-Track-2 code, so bad/wrong are ordinary notes with no filter applied", () => {
    // The recorded report was produced before any Track 2 validity/as-of code exists: every query's rankedIds
    // reflect plain semantic+keyword retrieval, so a retracted belief (bad/wrong) can appear anywhere, unfiltered.
    // This is exactly what the transforms in temporal-gate-proof.test.ts start from.
    const retractedPast = recorded.results.filter(r => r.tags?.includes("subset:retracted-past"));
    expect(retractedPast.length).toBeGreaterThan(0);
    expect(retractedPast.some(r => r.rankedIds.some(id => id.endsWith("-bad")))).toBe(true);
  });
});
