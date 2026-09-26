import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { readReport } from "./runner";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

const cost = { d1Statements: 1, d1RowsRead: null, aiCalls: 0, embeddingCalls: 0, vectorizeQueries: 0, kvReads: 0, neurons: 0, neuronsEstimated: false, wallMs: 1 };
const good = () => ({
  schema: 1, variant: "v", corpus: "c", embeddingModel: "m", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: 2,
  results: [{ queryId: "q", category: "cjk", clusterKey: "q", rankedIds: ["a"], leaked: [], cost, metrics: { recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 } }],
});
const load = (value: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), "eval-report-")), "r.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return () => readReport(path);
};

describe("readReport validation", () => {
  it("accepts a well-formed report", () => {
    expect(load(good())().results).toHaveLength(1);
  });

  it("rejects reports missing or mistyping the fields the gate relies on", () => {
    const bad: [string, (r: ReturnType<typeof good>) => unknown][] = [
      ["results", r => ({ ...r, results: "nope" })],
      ["topK", r => ({ ...r, topK: "10" })],
      ["runnerVersion", r => { const { runnerVersion, ...rest } = r; void runnerVersion; return rest; }],
      ["embeddingModel", r => ({ ...r, embeddingModel: 3 })],
      ["d1Backend", r => ({ ...r, d1Backend: "postgres" })],
      ["isolate", r => ({ ...r, isolate: "tepid" })],
      ["category", r => ({ ...r, results: [{ ...r.results[0], category: "vibes" }] })],
      ["queryId", r => ({ ...r, results: [{ ...r.results[0], queryId: 7 }] })],
      ["metrics", r => ({ ...r, results: [{ ...r.results[0], metrics: { recall5: 1 } }] })],
      ["cost", r => ({ ...r, results: [{ ...r.results[0], cost: undefined }] })],
      ["leaked", r => ({ ...r, results: [{ ...r.results[0], leaked: undefined }] })],
      ["rankedIds", r => ({ ...r, results: [{ ...r.results[0], rankedIds: "a" }] })],
      ["dataFingerprint", r => ({ ...r, dataFingerprint: ["x"] })],
      ["limit", r => ({ ...r, limit: 3.5 })],
    ];
    for (const [field, mutate] of bad) expect(load(mutate(good())), field).toThrow(new RegExp(field, "i"));
  });

  it("rejects non-JSON and a wrong schema", () => {
    expect(load("not json")).toThrow(/json/i);
    expect(load({ ...good(), schema: 2 })).toThrow(/schema/);
  });
});
