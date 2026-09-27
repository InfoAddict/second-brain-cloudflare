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

  it("gives every synthetic query a synthetic category, and an asOf only on the dated past questions", () => {
    for (const id of SYNTHETIC_CORPORA) {
      const corpus = buildSyntheticCorpus(id);
      expect(corpus.queries.length).toBeGreaterThan(0);
      for (const q of corpus.queries) {
        expect((SYNTHETIC_QUERY_CATEGORIES as readonly string[]).includes(q.category)).toBe(true);
        expect(q.gold.length > 0 || q.tags?.includes("standing:no")).toBe(true);
        expect(q.asOf !== undefined).toBe(id === "temporal" && q.category === "temporal");
      }
    }
  });

  it("gives temporal past questions distinct old and new gold, both present as documents", () => {
    const corpus = buildSyntheticCorpus("temporal");
    const ids = new Set(corpus.entries.map(e => e.id));
    const gold = corpus.queries.map(q => q.gold[0].id);
    for (const g of gold) expect(ids.has(g)).toBe(true);
    expect(new Set(gold).size).toBe(240);
  });
});

describe("standing measurement report", () => {
  it("prints precision and recall for every threshold, 0.30 through 0.90", () => {
    const standing = Array.from({ length: 13 }, (_, i) => ({ threshold: Number((0.3 + i * 0.05).toFixed(2)), precision: 0.25, recall: 0.5, truePositive: 1, falsePositive: 3, falseNegative: 1 }));
    const report: VariantReport = { schema: 1, variant: "no-rerank", corpus: "standing", embeddingModel: "hash-smoke", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: RUNNER_VERSION, results: [result("st-yes-0-0", "standing")], standing };
    const lines = formatReport(report).split("\n").filter(l => l.includes("threshold "));
    expect(lines).toHaveLength(13);
    expect(lines[0]).toMatch(/threshold 0\.30 {2}precision 0\.250 {2}recall 0\.500/);
    expect(lines[12]).toMatch(/threshold 0\.90 /);
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
