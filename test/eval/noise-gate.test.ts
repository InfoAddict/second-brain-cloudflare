import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSyntheticCorpus } from "./corpus/synthetic";
import type { CorpusEntry } from "./corpus/types";
import { evaluateGate } from "./gate";
import { blanketDemote, collapseAndCap, dropNonDirect, pureRecency } from "./noise-oracle";
import { scoreQuery } from "./metrics";
import { readReport } from "./runner";
import type { QueryResult, VariantReport } from "./types";

// IMPORTANT: unlike temporal-gate.test.ts (which proves gate MECHANICS ONLY with invented, hand-picked per-query
// rankings, by its own header's admission), every ranking judged here comes from `corpus/noise-baseline.recorded.json`,
// a REAL run of the shipped recall pipeline (local embeddings, local D1, no Cloudflare account; recorded 2026-09-27,
// commit at time of writing) against the corpus this file also builds. Each candidate below is a deterministic
// function of that recorded ranking and the corpus's own declared source/content (`noise-oracle.ts`), never a
// hand-picked winner. This is the T-0089.3.5 rebuild's answer to the round-4 finding on `temporal-during`
// (SYNTHETIC-CORPORA.md): a wrong change must be shown to fail this gate and a right one to pass it, both on real,
// recorded rankings.
//
// Reproduce: `npm run eval:recall -- prepare --variant baseline --corpus noise` then
// `npm run eval:recall -- --variant baseline --corpus noise --json test/eval/corpus/noise-baseline.recorded.json`
// (byte-identical apart from `wallMs`, confirmed by running it twice; see SYNTHETIC-CORPORA.md).

const corpus = buildSyntheticCorpus("noise");
const recorded = readReport(resolve(import.meta.dirname, "corpus/noise-baseline.recorded.json"));

describe("the recorded baseline fixture matches the live corpus", () => {
  it("carries the current corpus's data fingerprint: a corpus edit without a re-recording fails loudly here, not silently", () => {
    expect(recorded.dataFingerprint).toEqual(corpus.dataFingerprint);
  });
  it("covers every query the live corpus generates, one result each", () => {
    expect(recorded.results.map(r => r.queryId).sort()).toEqual(corpus.queries.map(q => q.id).sort());
  });
  it("was produced by a real run, not a smoke or hash-embedding stand-in", () => {
    expect(recorded.embeddingModel).not.toBe("hash-smoke");
    expect(Object.keys(recorded.producers ?? {}).length).toBeGreaterThan(0);
  });
});

const byId = new Map<string, CorpusEntry>(corpus.entries.map(e => [e.id, e] as const));
const byQueryId = new Map(corpus.queries.map(q => [q.id, q] as const));

// The gate is judged on the held-out test half only (T-0089.3.5 director addition): Track 3 tunes its weights, cap
// and collapse against the dev half, so the half that proves the tuned result must be one tuning never saw.
const testResults = recorded.results.filter(r => byQueryId.get(r.queryId)?.tags?.includes("split:test"));

function rebuild(variant: string, transform: (r: QueryResult) => string[]): VariantReport {
  return {
    ...recorded,
    variant,
    results: testResults.map(r => {
      const rankedIds = transform(r);
      return { ...r, rankedIds, metrics: scoreQuery(rankedIds, byQueryId.get(r.queryId)!.gold) };
    }),
  };
}

const testBaseline = rebuild("baseline", r => r.rankedIds);
const FEW = { bootstrap: { iterations: 1000 } } as const;
const scopeDelta = (result: ReturnType<typeof evaluateGate>, scope: string, metric = "mrr10") => result.deltas.find(d => d.scope === scope && d.metric === metric);

describe("power floor", () => {
  it("the held-out test half alone clears the gate's 200-query, 30-cluster floor", () => {
    expect(testResults.length).toBeGreaterThanOrEqual(200);
    expect(new Set(testResults.map(r => r.clusterKey)).size).toBeGreaterThanOrEqual(30);
  });
});

describe("the combined Track 3 change (near-duplicate collapse + occupancy cap, source-word lift) passes", () => {
  const candidate = rebuild("collapse-and-cap", r => collapseAndCap(r.rankedIds, byQueryId.get(r.queryId)!, byId));
  const result = evaluateGate(testBaseline, candidate, { ...FEW, targetCategories: ["noise"] });

  it("does not regress the category, and shows a proven overall or targeted gain", () => {
    expect(result.rules.find(r => r.rule === "regression")!.status).toBe("pass");
    const improvement = result.rules.find(r => r.rule === "improvement")!;
    expect(improvement.status).toBe("pass");
    expect(improvement.detail).toMatch(/(overall|noise) (recall10|mrr10) \+/);
  });

  it("recovers real headroom on the crowded subsets this corpus was rebuilt to catch", () => {
    for (const subset of ["transcript-crowding", "probe-footer-synonym", "note-same-topic-transcript"]) {
      const row = scopeDelta(result, `noise [subset:${subset}]`);
      expect(row, `expected a report row for subset ${subset}`).toBeDefined();
      expect(row!.ci.mean, `${subset} MRR@10 delta`).toBeGreaterThan(0);
    }
  });

  it("mail-crowding: no regression, but no recovery on this recorded baseline's test half either", () => {
    // Traced by hand (see SYNTHETIC-CORPORA.md): on this corpus, mail-crowding's gold is either already ranked
    // first (nothing to fix) or pushed past what a top-10 rerank can see (nothing post-hoc reordering of a
    // recorded top-10 can recover, since the pool below rank 10 was never captured in the report). Unlike
    // transcript-crowding, no query in the test half landed in a recoverable middle. Documented as a finding, not
    // chased further with more corpus content.
    const row = scopeDelta(result, "noise [subset:mail-crowding]")!;
    expect(row.ci.mean).toBeGreaterThanOrEqual(0);
  });

  it("does not touch the queries that genuinely want the mail or the transcript", () => {
    for (const subset of ["email-control", "transcript-control", "recurring", "transcript-recurring"]) {
      const row = scopeDelta(result, `noise [subset:${subset}]`)!;
      expect(row.ci.mean, `${subset} MRR@10 delta`).toBeGreaterThanOrEqual(-0.01);
    }
  });
});

describe("wrong changes fail", () => {
  it("blanket demotion of every mirror/transcript row, with no source-word lift, breaks the 'wants the mail' and 'wants the transcript' queries", () => {
    const candidate = rebuild("blanket-demote", r => blanketDemote(r.rankedIds, byId));
    const result = evaluateGate(testBaseline, candidate, { ...FEW, targetCategories: ["noise"] });
    expect(result.verdict).toBe("FAIL");
    expect(result.rules.find(r => r.rule === "regression")!.status).toBe("fail");
    const emailControl = scopeDelta(result, "noise [subset:email-control]")!;
    const transcriptControl = scopeDelta(result, "noise [subset:transcript-control]")!;
    expect(emailControl.ci.mean).toBeLessThan(0);
    expect(transcriptControl.ci.mean).toBeLessThan(0);
  });

  it("dropping every mirror/transcript row outright fails at least as badly", () => {
    const candidate = rebuild("drop-non-direct", r => dropNonDirect(r.rankedIds, byId));
    const result = evaluateGate(testBaseline, candidate, { ...FEW, targetCategories: ["noise"] });
    expect(result.verdict).toBe("FAIL");
    expect(result.rules.find(r => r.rule === "regression")!.status).toBe("fail");
    const emailControl = scopeDelta(result, "noise [subset:email-control]", "recall10")!;
    expect(emailControl.ci.mean).toBeLessThan(0);
  });

  it("pure recency, ignoring source class and relevance entirely, fails: reordering by age is not the mechanism", () => {
    const candidate = rebuild("pure-recency", r => pureRecency(r.rankedIds, byId));
    const result = evaluateGate(testBaseline, candidate, { ...FEW, targetCategories: ["noise"] });
    expect(result.verdict).toBe("FAIL");
    expect(result.rules.find(r => r.rule === "regression")!.status).toBe("fail");
  });
});
