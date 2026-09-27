import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRANSCRIPT_SOURCES } from "../../src/constants";
import { buildSyntheticCorpus } from "./corpus/synthetic";
import type { CorpusEntry } from "./corpus/types";
import { evaluateGate } from "./gate";
import { blanketDemote, dropNonDirect, productionRerank, pureRecency } from "./noise-oracle";
import { scoreQuery } from "./metrics";
import { readReport } from "./runner";
import type { GoldenQuery, QueryResult, VariantReport } from "./types";

// IMPORTANT: unlike temporal-gate.test.ts (which proves gate MECHANICS ONLY with invented, hand-picked per-query
// rankings, by its own header's admission), every ranking judged here comes from `corpus/noise-baseline.recorded.json`,
// a REAL run of the shipped recall pipeline (local embeddings, local D1, no Cloudflare account) against the corpus
// this file also builds. The "correct" candidate is production's own `collapseNearDuplicates` and `applyOccupancyCap`
// (`src/recall/source-trust.ts`, v4/t3-r 60b84f78), imported and run unmodified against each entry's own declared
// source/content/tags/createdAt: never a hand-picked winner, and never the query's gold (see the structural test
// below). This is the T-0089.3.5 rebuild's second answer to "prove it on the recorded baseline, not invented
// rankings": round 2 used invented per-query oracle logic that read the gold answer to decide what to protect from
// collapse and demotion (a real Codex review finding, reported and fixed here, not just the round-4 lesson on
// `temporal-during` this file's comment previously cited alone).
//
// Reproduce: `npm run eval:recall -- prepare --variant baseline --corpus noise` then
// `npm run eval:recall -- --variant baseline --corpus noise --json test/eval/corpus/noise-baseline.recorded.json`
// (byte-identical apart from `wallMs`, confirmed by running it twice; see SYNTHETIC-CORPORA.md).

// `codex-session` and `cursor-session` (the T-0089.3.5 director addition) are not yet in
// `src/constants.ts`'s `TRANSCRIPT_SOURCES` (only `claude-code` is, as of v4/t3-r 60b84f78): the
// hooks lane that adds them has not landed. `sourceClass` reads `TRANSCRIPT_SOURCES` live by
// design (its own comment: "a new label added to either set is classified with no change here"),
// so this test registers the two labels for its own duration only, restoring the set afterward.
// Vitest isolates modules per test file by default, so this cannot affect `source-trust.test.ts`
// or any other file's own import of the same module.
beforeAll(() => { (TRANSCRIPT_SOURCES as Set<string>).add("codex-session").add("cursor-session"); });
afterAll(() => { (TRANSCRIPT_SOURCES as Set<string>).delete("codex-session"); (TRANSCRIPT_SOURCES as Set<string>).delete("cursor-session"); });

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

describe("structural: the correct candidate never reads the query's gold", () => {
  /** Throws the instant anything reads `.gold`, so the proof is a runtime fact, not a type-level claim. */
  function noGoldQuery(q: GoldenQuery): GoldenQuery {
    return new Proxy(q, {
      get(target, prop, receiver) {
        if (prop === "gold") throw new Error(`gold accessed on query ${target.id} while reranking: a candidate must never see the answer key`);
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  it("reranks every test-half query through a gold-throwing proxy without ever touching gold", () => {
    for (const r of testResults) {
      const q = noGoldQuery(byQueryId.get(r.queryId)!);
      expect(() => productionRerank(r.rankedIds, q.text, byId)).not.toThrow();
    }
  });

  it("CollapseCandidate and OccupancyCandidate (src/recall/source-trust.ts) have no gold-shaped field: gold cannot reach them even by accident", () => {
    const candidate = { id: "x", content: "c", source: "api", tags: [], createdAt: 0 };
    expect(Object.keys(candidate)).not.toContain("gold");
  });
});

describe("the production Track 3 change (lane R's collapse + occupancy cap, v4/t3-r 60b84f78) on the recorded baseline", () => {
  // Computed in a nested beforeAll, not at describe-body top level: describe callbacks run during
  // vitest's collection phase, BEFORE the file's top-level beforeAll has registered codex-session
  // and cursor-session as transcript sources, so a top-level `const result = ...` here would
  // silently classify them as "direct" and understate the cap's effect. Confirmed live: computing
  // it at top level and inside an `it` gave different regression verdicts on the identical inputs.
  let result: ReturnType<typeof evaluateGate>;
  beforeAll(() => {
    const candidate = rebuild("production-rerank", r => productionRerank(r.rankedIds, byQueryId.get(r.queryId)!.text, byId));
    result = evaluateGate(testBaseline, candidate, { ...FEW, targetCategories: ["noise"] });
  });

  it("prints the regression and improvement verdicts and every subset delta (see SYNTHETIC-CORPORA.md for the numbers this asserts against)", () => {
    expect(result.rules.find(r => r.rule === "regression")).toBeDefined();
    expect(result.rules.find(r => r.rule === "improvement")).toBeDefined();
  });

  it("does not regress the category", () => {
    expect(result.rules.find(r => r.rule === "regression")!.status).toBe("pass");
  });

  it("does not touch the queries that genuinely want the mail or the transcript", () => {
    for (const subset of ["email-control", "transcript-control", "recurring", "transcript-recurring"]) {
      const row = scopeDelta(result, `noise [subset:${subset}]`)!;
      expect(row.ci.mean, `${subset} MRR@10 delta`).toBeGreaterThanOrEqual(-0.01);
    }
  });

  // Honest finding (director's instruction: report this with numbers, do not hide it): collapse in
  // production is mirror-only (never transcript, src/recall/source-trust.ts's collapseNearDuplicates),
  // and sourceWeight itself cannot be replayed from a recorded top-10 (it multiplies a raw fused
  // score before ranking; the report carries no scores). So the correct candidate here is collapse
  // plus the occupancy cap alone, and it shows a real, proven, but SUB-MARGIN gain: the overall MRR@10
  // delta's bootstrap CI excludes zero (there is a genuine effect) but its mean is below the gate's
  // 0.02 improvement margin, so the improvement rule reads FAIL, not PASS, and honestly so.
  it("shows a real but sub-margin overall gain: proven non-zero, not large enough to pass the improvement rule", () => {
    const overall = scopeDelta(result, "noise")!;
    expect(overall.ci.lo, "overall MRR@10 delta lower bound (should exclude zero: a real effect)").toBeGreaterThan(0);
    expect(overall.ci.mean, "overall MRR@10 delta mean (below the 0.02 margin)").toBeLessThan(0.02);
    expect(result.rules.find(r => r.rule === "improvement")!.status).toBe("fail");
  });

  it("concentrates its gain in probe-footer-synonym and transcript-crowding; mail-crowding and note-same-topic-transcript show none", () => {
    const synonym = scopeDelta(result, "noise [subset:probe-footer-synonym]")!;
    const transcriptCrowding = scopeDelta(result, "noise [subset:transcript-crowding]")!;
    expect(synonym.ci.lo).toBeGreaterThan(0);
    expect(transcriptCrowding.ci.lo).toBeGreaterThanOrEqual(0);
    for (const subset of ["mail-crowding", "note-same-topic-transcript"]) {
      const row = scopeDelta(result, `noise [subset:${subset}]`)!;
      expect(row.ci.mean, `${subset} MRR@10 delta`).toBe(0);
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
