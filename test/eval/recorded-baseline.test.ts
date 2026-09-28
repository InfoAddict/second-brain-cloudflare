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

  it("is a recorded baseline, not a lock: pre-Track-2 code, but still today's production retrieval, so a deprecated belief (bad/wrong) never appears at all", () => {
    // The recorded report was produced before any Track 2 validity/as-of code exists, but release/v4 recall
    // already excludes deprecated rows before ranking (search.ts:872) -- that filter predates Track 2 and has
    // nothing to do with it. A baseline that let bad/wrong through unfiltered would not be today's production
    // state, and (T-0089.2.6 adversary round) let a candidate with no as-of logic of its own pass purely by
    // riding that pre-existing filter. bad/wrong carry status:deprecated for exactly this reason.
    const byId = new Map(corpus.entries.map(e => [e.id, e] as const));
    const deprecated = new Set([...byId.values()].filter(e => e.tags.includes("status:deprecated")).map(e => e.id));
    expect(deprecated.size).toBeGreaterThan(0);
    const leaked = recorded.results.filter(r => r.rankedIds.some(id => deprecated.has(id)));
    expect(leaked.map(r => r.queryId)).toEqual([]);
  });
});
