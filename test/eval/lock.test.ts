import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LockRefused, applyLock, historyProblems, type Manifest } from "./lock";
import type { VariantReport } from "./types";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const cost = { d1Statements: 1, d1RowsRead: null, aiCalls: 0, embeddingCalls: 0, vectorizeQueries: 0, kvReads: 0, neurons: 0, neuronsEstimated: false, wallMs: 12 };
const report = (o: { leaked?: string[] } = {}): VariantReport => ({
  schema: 1, variant: "baseline", corpus: "core-1k", embeddingModel: "m", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: 1,
  results: [{ queryId: "q", category: "identifier", clusterKey: "q", rankedIds: ["a"], leaked: o.leaked ?? [], cost, metrics: { recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 } }],
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "eval-lock-"));
  writeFileSync(join(dir, "queries.jsonl"), "v1\n");
  const manifest: Manifest = { corpus: "core", files: { "queries.jsonl": sha("v1\n") } };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const lockPath = join(dir, "baselines", "lock.json");
  const run = vi.fn(async () => report());
  const read = () => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  return { dir, lockPath, run, read };
}

describe("applyLock", () => {
  it("with unchanged data refreshes only the baseline (wall clock zeroed) and leaves the manifest byte-identical", async () => {
    const t = setup();
    const before = readFileSync(join(t.dir, "manifest.json"), "utf8");
    const out = await applyLock({ dataDir: t.dir, lockPath: t.lockPath, runBaseline: t.run });
    expect(out.dataChanged).toBe(false);
    expect(readFileSync(join(t.dir, "manifest.json"), "utf8")).toBe(before);
    expect((JSON.parse(readFileSync(t.lockPath, "utf8")) as VariantReport).results[0].cost.wallMs).toBe(0);
  });

  it("refuses changed data without --accept-data-change, before running the baseline or writing anything", async () => {
    const t = setup();
    writeFileSync(join(t.dir, "queries.jsonl"), "v2\n");
    const before = readFileSync(join(t.dir, "manifest.json"), "utf8");
    await expect(applyLock({ dataDir: t.dir, lockPath: t.lockPath, runBaseline: t.run })).rejects.toThrow(/queries\.jsonl.*--accept-data-change/);
    await expect(applyLock({ dataDir: t.dir, lockPath: t.lockPath, acceptReason: "  ", runBaseline: t.run })).rejects.toBeInstanceOf(LockRefused);
    expect(t.run).not.toHaveBeenCalled();
    expect(readFileSync(join(t.dir, "manifest.json"), "utf8")).toBe(before);
  });

  it("with --accept-data-change appends a history entry (dates, old/new hashes, reason, baseline summary) and updates the hashes", async () => {
    const t = setup();
    writeFileSync(join(t.dir, "queries.jsonl"), "v2\n");
    const out = await applyLock({ dataDir: t.dir, lockPath: t.lockPath, acceptReason: "added 10 queries", runBaseline: t.run, now: () => new Date("2026-09-24T00:00:00Z") });
    expect(out.dataChanged).toBe(true);
    const m = t.read();
    expect(m.files["queries.jsonl"]).toBe(sha("v2\n"));
    expect(m.history).toHaveLength(1);
    expect(m.history![0]).toMatchObject({
      date: "2026-09-24T00:00:00.000Z", reason: "added 10 queries",
      files: { "queries.jsonl": { old: sha("v1\n"), new: sha("v2\n") } },
      baseline: { variant: "baseline", corpus: "core-1k", queries: 1, recall5: 1, errors: 0, degraded: 0, leaks: 0 },
    });
    expect(historyProblems(m)).toEqual([]);
    // a second accepted change chains onto the first
    writeFileSync(join(t.dir, "queries.jsonl"), "v3\n");
    await applyLock({ dataDir: t.dir, lockPath: t.lockPath, acceptReason: "fix typo", runBaseline: t.run });
    const m2 = t.read();
    expect(m2.history).toHaveLength(2);
    expect(m2.history![1].files["queries.jsonl"].old).toBe(sha("v2\n"));
    expect(historyProblems(m2)).toEqual([]);
  });

  it("refuses to lock a broken baseline and writes nothing, even with data accepted", async () => {
    const t = setup();
    writeFileSync(join(t.dir, "queries.jsonl"), "v2\n");
    const before = readFileSync(join(t.dir, "manifest.json"), "utf8");
    await expect(applyLock({ dataDir: t.dir, lockPath: t.lockPath, acceptReason: "x", runBaseline: async () => report({ leaked: ["z"] }) })).rejects.toThrow(/broken baseline/);
    expect(readFileSync(join(t.dir, "manifest.json"), "utf8")).toBe(before);
  });

  it("refuses when the manifest hashes were edited without a history entry", async () => {
    const t = setup();
    await applyLock({ dataDir: t.dir, lockPath: t.lockPath, runBaseline: t.run }); // baseline only
    writeFileSync(join(t.dir, "queries.jsonl"), "v2\n");
    await applyLock({ dataDir: t.dir, lockPath: t.lockPath, acceptReason: "r", runBaseline: t.run });
    const m = t.read();
    m.files["queries.jsonl"] = sha("forged");
    expect(historyProblems(m).join(" ")).toMatch(/without a history entry/);
    writeFileSync(join(t.dir, "manifest.json"), JSON.stringify(m));
    await expect(applyLock({ dataDir: t.dir, lockPath: t.lockPath, runBaseline: t.run })).rejects.toThrow(/history is inconsistent/);
  });
});
