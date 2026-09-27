import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatReport, parseCli } from "./cli";
import { CORPUS_IDS } from "./corpus/build";
import { SYNTHETIC_CORPORA, buildSyntheticCorpus } from "./corpus/synthetic";
import { listCorpora, replayPaths } from "./corpora";
import { ALL_QUERY_CATEGORIES, QUERY_CATEGORIES, RUNNER_VERSION, SYNTHETIC_QUERY_CATEGORIES, type CostSample, type QueryResult, type VariantReport } from "./types";

const cost: CostSample = { d1Statements: 8, d1RowsRead: null, aiCalls: 1, embeddingCalls: 1, vectorizeQueries: 1, kvReads: 1, neurons: 2, neuronsEstimated: false, wallMs: 30 };
const result = (queryId: string, category: QueryResult["category"]): QueryResult => ({
  queryId, category, clusterKey: queryId, rankedIds: [], leaked: [], metrics: { recall5: 0, recall10: 0, mrr10: 0, ndcg10: 0 }, cost,
});

describe("synthetic corpora stay out of the core eval", () => {
  it("keeps QUERY_CATEGORIES to the nine core categories, disjoint from the synthetic ones", () => {
    expect([...QUERY_CATEGORIES]).toEqual(["identifier", "cjk", "rare-word", "common-word", "short-word", "paraphrase", "multi-hop", "long-context", "agent-framed"]);
    expect(ALL_QUERY_CATEGORIES).toEqual([...QUERY_CATEGORIES, ...SYNTHETIC_QUERY_CATEGORIES]);
    for (const c of SYNTHETIC_QUERY_CATEGORIES) expect((QUERY_CATEGORIES as readonly string[]).includes(c)).toBe(false);
  });

  it("does not add the synthetic ids to the core set and selects core-1k by default", () => {
    for (const id of SYNTHETIC_CORPORA) expect((CORPUS_IDS as readonly string[]).includes(id)).toBe(false);
    expect([...CORPUS_IDS]).toEqual(["core-1k", "scale-5k", "scale-20k"]);
    expect(parseCli(["--variant", "baseline"])).toMatchObject({ corpus: "core-1k" });
    expect(listCorpora()).toEqual(expect.arrayContaining([...SYNTHETIC_CORPORA]));
  });

  it("never lets a synthetic corpus read or write the committed core replay cache", () => {
    for (const id of SYNTHETIC_CORPORA) {
      const p = replayPaths("@cf/baai/bge-small-en-v1.5", id);
      expect(p.write).toContain(`.eval-cache/replay/${id}.`);
      expect(p.read.every(f => !f.includes("test/eval/data"))).toBe(true);
    }
  });

  it("gives every synthetic query a synthetic category, and an asOf only on the pre-filtered past questions", () => {
    for (const id of SYNTHETIC_CORPORA) {
      const corpus = buildSyntheticCorpus(id);
      expect(corpus.queries.length).toBeGreaterThan(0);
      for (const q of corpus.queries) {
        expect((SYNTHETIC_QUERY_CATEGORIES as readonly string[]).includes(q.category)).toBe(true);
        expect(q.gold.length > 0 || q.tags?.some(t => ["standing:overlap", "standing:intent", "standing:unrelated"].includes(t))).toBe(true);
        expect(q.asOf !== undefined).toBe(id === "temporal" && !!q.tags?.includes("subset:prefiltered"));
      }
    }
  });

  it("points every temporal gold id at a document that exists", () => {
    const corpus = buildSyntheticCorpus("temporal");
    const ids = new Set(corpus.entries.map(e => e.id));
    for (const q of corpus.queries) for (const g of q.gold) expect(ids.has(g.id)).toBe(true);
  });
});

describe("standing measurement report", () => {
  it("prints both query embeddings' firing curves, the dev-chosen threshold and the held-out intervals", () => {
    const point = (threshold: number) => ({ threshold, precision: 0.25, recall: 0.5, truePositive: 1, falsePositive: 3, falseNegative: 1, intentFired: 2, intentQueries: 9 });
    const input = { curve: Array.from({ length: 13 }, (_, i) => point(Number((0.3 + i * 0.05).toFixed(2)))), chosen: { threshold: 0.7, meetsPrecisionTarget: false, dev: point(0.7), test: { ...point(0.7), precisionCi: [0.1, 0.5] as [number, number], recallCi: [0.2, 0.8] as [number, number] } } };
    const standing = { groups: { yes: 5, overlap: 4, intent: 3, unrelated: 20 }, memories: 30, inputs: { distilled: input, raw: input } };
    const report: VariantReport = { schema: 1, variant: "no-rerank", corpus: "standing", embeddingModel: "hash-smoke", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: RUNNER_VERSION, results: [result("st-yes-0-0", "standing")], standing };
    const text = formatReport(report);
    expect(text.split("\n").filter(l => /^ {4}threshold /.test(l))).toHaveLength(26);
    expect(text).toMatch(/threshold 0\.30 {2}precision 0\.250 {2}recall 0\.500/);
    expect(text).toContain("firing curve, distilled query embedding");
    expect(text).toContain("firing curve, raw query embedding");
    expect(text).toMatch(/chosen on dev: threshold 0\.70 \(misses precision 0\.9\)/);
    expect(text).toContain("same-subject-other-intent fired 2/9");
  });

  it("omits the standing block for a report that has none, so core output is unchanged", () => {
    const report: VariantReport = { schema: 1, variant: "baseline", corpus: "core-1k", embeddingModel: "hash-smoke", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: RUNNER_VERSION, results: [result("q-1", "paraphrase")] };
    const text = formatReport(report);
    expect(text).not.toMatch(/standing|planted|genuine note/);
  });
});

describe("SYNTHETIC-CORPORA.md", () => {
  const doc = readFileSync(resolve(import.meta.dirname, "SYNTHETIC-CORPORA.md"), "utf8");
  it("contains no em or en dashes", () => {
    expect(doc).not.toMatch(/[–—]/);
  });
  it("names only commands that exist: every corpus in its table is registered", () => {
    for (const id of SYNTHETIC_CORPORA) expect(doc).toContain(`\`${id}\``);
    expect(doc).toContain("npm run eval:recall -- prepare --variant baseline --corpus ID");
  });
});
