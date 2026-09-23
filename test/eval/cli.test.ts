import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UsageError, describeVerdict, exitCodeFor, formatKnownGapDelta, formatReport, main, parseCli } from "./cli";
import { registerCorpusProvider } from "./corpora";
import { ACTORS, EVAL_NOW, WORKSPACES, type CorpusEntry } from "./corpus/types";
import type { CostSample, GoldenQuery, QueryResult, VariantReport } from "./types";

const cost: CostSample = { d1Statements: 8, d1RowsRead: null, aiCalls: 1, embeddingCalls: 1, vectorizeQueries: 1, kvReads: 1, neurons: 2, neuronsEstimated: false, wallMs: 30 };
const result = (o: Partial<QueryResult> & { queryId: string }): QueryResult => ({
  category: "paraphrase", clusterKey: o.queryId, rankedIds: [], leaked: [],
  metrics: { recall5: 0.5, recall10: 0.75, mrr10: 0.4, ndcg10: 0.6 }, cost, ...o,
});
const report = (results: QueryResult[], o: Partial<VariantReport> = {}): VariantReport => ({
  schema: 1, variant: "baseline", corpus: "c", embeddingModel: "hash-smoke", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: 1, results, ...o,
});

describe("parseCli", () => {
  it("parses the contract forms", () => {
    expect(parseCli(["--variant", "rerank", "--corpus", "scale-20k", "--json", "/tmp/x.json"]))
      .toMatchObject({ kind: "run", variant: "rerank", corpus: "scale-20k", json: "/tmp/x.json", d1: "sqlite", isolate: "warm" });
    expect(parseCli(["--compare", "baseline,rerank", "--target", "paraphrase,common-word", "--allow-unmeasured-rows"]))
      .toMatchObject({ kind: "compare", variants: ["baseline", "rerank"], corpus: "core-1k", target: ["paraphrase", "common-word"], allowUnmeasuredRows: true });
    expect(parseCli(["prepare", "--variant", "baseline", "--corpus", "core-1k", "--max-neurons", "500"]))
      .toMatchObject({ kind: "prepare", maxNeurons: 500 });
    expect(parseCli(["lock"])).toMatchObject({ kind: "lock", corpus: "core-1k" });
    expect(parseCli(["lock", "--accept-data-change", "new queries"])).toMatchObject({ kind: "lock", acceptDataChange: "new queries" });
    expect(parseCli(["--list"])).toEqual({ kind: "list" });
  });

  it("rejects bad input with a UsageError", () => {
    expect(() => parseCli([])).toThrow(UsageError);
    expect(() => parseCli(["--variant", "x", "--d1", "postgres"])).toThrow(/d1/);
    expect(() => parseCli(["--compare", "onlyone"])).toThrow(/two/);
    expect(() => parseCli(["--compare", "a,b", "--target", "nonsense"])).toThrow(/category/);
    expect(() => parseCli(["--variant", "x", "--isolate", "lukewarm"])).toThrow(/isolate/);
    expect(() => parseCli(["--variant", "x", "--limit", "abc"])).toThrow(/limit/);
    expect(() => parseCli(["prepare", "--variant", "x", "--max-neurons", "-1"])).toThrow(/max-neurons/);
    expect(() => parseCli(["--bogus"])).toThrow(UsageError);
    expect(() => parseCli(["lock", "--accept-data-change", " "])).toThrow(/reason/);
    expect(() => parseCli(["--variant", "x", "--accept-data-change", "why"])).toThrow(/only applies to lock/);
  });
});

describe("exit codes and formatting", () => {
  it("maps verdicts to 0, 1, and 3", () => {
    expect([exitCodeFor("PASS"), exitCodeFor("FAIL"), exitCodeFor("INCONCLUSIVE")]).toEqual([0, 1, 3]);
  });

  it("prints per-category metrics, cost, degraded counts, and a hash-embedding warning", () => {
    const text = formatReport(report([result({ queryId: "q", degraded: ["semantic-unavailable"] }), result({ queryId: "r" })]));
    expect(text).toMatch(/paraphrase/);
    expect(text).toMatch(/0\.750/);
    expect(text).toMatch(/rows_read: not measured/);
    expect(text).toMatch(/WARNING.*hash/i);
    expect(text).toMatch(/degraded 1/);
  });

  it("scores every query in the headline, then shows the excluding-known-gaps view and the gap breakdown", () => {
    const text = formatReport(report([
      result({ queryId: "ok", category: "identifier", metrics: { recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 } }),
      result({ queryId: "gap", category: "identifier", tags: ["known-gap", "gap:T-0072"], metrics: { recall5: 0, recall10: 0, mrr10: 0, ndcg10: 0 } }),
    ]));
    const lines = text.split("\n");
    const split = lines.findIndex(l => /excluding known gaps/.test(l));
    expect(split).toBeGreaterThan(0);
    const headline = lines.slice(0, split).find(l => /^\s+identifier\s/.test(l))!;
    expect(headline).toMatch(/n=2\s/);
    expect(headline).toMatch(/recall@5 0\.500/);
    const excluding = lines.slice(split).find(l => /^\s+identifier\s/.test(l))!;
    expect(excluding).toMatch(/n=1\s/);
    expect(excluding).toMatch(/recall@5 1\.000/);
    expect(lines.slice(split).find(l => /^\s+overall\s/.test(l))).toMatch(/n=1\s/);
    expect(text).toMatch(/gap:T-0072\s+n=1\s.*recall@5 0\.000/);
  });

  it("names the rule behind a verdict", () => {
    const rule = (r: string, status: "pass" | "fail" | "inconclusive") => ({ rule: r, status, detail: "" });
    expect(describeVerdict({ verdict: "FAIL", deltas: [], rules: [rule("regression", "pass"), rule("improvement", "fail")] })).toMatch(/improvement only; no regression/);
    expect(describeVerdict({ verdict: "FAIL", deltas: [], rules: [rule("isolation", "fail"), rule("improvement", "fail")] })).toBe("FAIL (failed: isolation, improvement)");
    expect(describeVerdict({ verdict: "INCONCLUSIVE", deltas: [], rules: [rule("power", "inconclusive")] })).toBe("INCONCLUSIVE (power)");
    expect(describeVerdict({ verdict: "PASS", deltas: [], rules: [] })).toBe("PASS");
  });

  it("prints no known-gap block when no query is tagged", () => {
    expect(formatReport(report([result({ queryId: "a" })]))).not.toMatch(/known gap/i);
  });

  it("compares known-gap groups between two reports", () => {
    const gap = (r5: number) => result({ queryId: "g", tags: ["gap:T-0073"], metrics: { recall5: r5, recall10: r5, mrr10: r5, ndcg10: r5 } });
    const text = formatKnownGapDelta(report([gap(0)]), report([gap(1)], { variant: "rerank" }));
    expect(text).toMatch(/gap:T-0073/);
    expect(text).toMatch(/0\.000 -> 1\.000/);
    expect(formatKnownGapDelta(report([result({ queryId: "a" })]), report([result({ queryId: "a" })]))).toBe("");
  });
});

describe("main (end to end on a tiny registered corpus)", () => {
  const entry = (id: string, content: string, ws: keyof typeof WORKSPACES = "avery"): CorpusEntry => ({
    id, content, tags: [], source: "api", createdAt: EVAL_NOW - 86_400_000, workspaceId: WORKSPACES[ws], actorId: ACTORS.avery,
  });
  const queries: GoldenQuery[] = Array.from({ length: 4 }, (_, i) => ({
    id: `q${i}`, category: "rare-word", text: `zebra${i} alpha`, gold: [{ id: `a${i}`, grade: 2 }], viewer: "avery", ...(i === 3 && { tags: ["known-gap", "gap:T-0072"] }),
  }));
  registerCorpusProvider("tiny-cli", id => id === "tiny-cli", () => ({
    id: "tiny-cli", intent: "tie",
    entries: [...queries.map((q, i) => entry(`a${i}`, `note about zebra${i} alpha planning`)), ...Array.from({ length: 12 }, (_, i) => entry(`f${i}`, `gardening note ${i}`))],
    edges: [], queries,
  }));
  const outPath = () => join(mkdtempSync(join(tmpdir(), "eval-cli-")), "r.json");

  it("runs a variant with hash embeddings, writes JSON carrying tags, and exits 0", async () => {
    const out = outPath();
    expect(await main(["--variant", "baseline", "--corpus", "tiny-cli", "--hash-embeddings", "--json", out])).toBe(0);
    const r = JSON.parse(readFileSync(out, "utf8")) as VariantReport;
    expect(r.results).toHaveLength(4);
    expect(r.embeddingModel).toBe("hash-smoke");
    expect(r.results[3].tags).toEqual(["known-gap", "gap:T-0072"]);
  });

  it("compare exits 3 (inconclusive) when the query set is below the power floor, and 2 on a usage error", async () => {
    expect(await main(["--compare", "baseline,like", "--corpus", "tiny-cli", "--hash-embeddings", "--allow-unmeasured-rows"])).toBe(3);
    expect(await main(["--compare", "baseline"])).toBe(2);
  });

  it("compares saved report files and returns 1 (FAIL) on a hard-invariant violation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-cli-"));
    const good = report([result({ queryId: "a" })]);
    const leaky = report([result({ queryId: "a", leaked: ["x"] })], { variant: "bad" });
    writeFileSync(join(dir, "b.json"), JSON.stringify(good));
    writeFileSync(join(dir, "c.json"), JSON.stringify(leaky));
    expect(await main(["--compare", `${join(dir, "b.json")},${join(dir, "c.json")}`, "--allow-unmeasured-rows"])).toBe(1);
  });

  it("a hash-embedding comparison can never PASS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-cli-"));
    const many = report(Array.from({ length: 240 }, (_, i) => result({ queryId: `q${i}`, category: "paraphrase", clusterKey: `c${i % 40}` })));
    writeFileSync(join(dir, "b.json"), JSON.stringify(many));
    const better = { ...many, variant: "better", results: many.results.map(r => ({ ...r, metrics: { recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 } })) };
    writeFileSync(join(dir, "c.json"), JSON.stringify(better));
    expect(await main(["--compare", `${join(dir, "b.json")},${join(dir, "c.json")}`, "--allow-unmeasured-rows"])).toBe(3);
  });

  it("lock refuses hash embeddings and never writes", async () => {
    expect(await main(["lock", "--corpus", "tiny-cli", "--hash-embeddings"])).toBe(2);
  });

  it("prepare without credentials exits 2 before any live call", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(await main(["prepare", "--variant", "baseline", "--corpus", "tiny-cli"])).toBe(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("--list prints variants and corpora", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["--list"])).toBe(0);
      const out = log.mock.calls.map(c => String(c[0])).join("\n");
      expect(out).toMatch(/baseline/);
      expect(out).toMatch(/core-1k/);
    } finally {
      log.mockRestore();
    }
  });
});
