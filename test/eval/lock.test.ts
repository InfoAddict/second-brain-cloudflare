import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LockRefused, applyLock, compareToLock, hashDataDir, historyProblems, type Manifest } from "./lock";
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
  const manifest: Manifest = {
    corpus: "core", files: { "queries.jsonl": sha("v1\n") },
    history: [{ date: "2026-09-23T00:00:00.000Z", reason: "genesis", files: { "queries.jsonl": { old: "", new: sha("v1\n") } } }],
  };
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
    expect(m.history).toHaveLength(2); // genesis + this change
    expect(m.history![1]).toMatchObject({
      date: "2026-09-24T00:00:00.000Z", reason: "added 10 queries",
      files: { "queries.jsonl": { old: sha("v1\n"), new: sha("v2\n") } },
      baseline: { variant: "baseline", corpus: "core-1k", queries: 1, recall5: 1, errors: 0, degraded: 0, leaks: 0 },
    });
    expect(historyProblems(m)).toEqual([]);
    // a second accepted change chains onto the first
    writeFileSync(join(t.dir, "queries.jsonl"), "v3\n");
    await applyLock({ dataDir: t.dir, lockPath: t.lockPath, acceptReason: "fix typo", runBaseline: t.run });
    const m2 = t.read();
    expect(m2.history).toHaveLength(3);
    expect(m2.history![2].files["queries.jsonl"].old).toBe(sha("v2\n"));
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

  it("requires a genesis entry: an empty history cannot anchor the chain", async () => {
    const t = setup();
    const m = t.read();
    delete m.history;
    writeFileSync(join(t.dir, "manifest.json"), JSON.stringify(m));
    await expect(applyLock({ dataDir: t.dir, lockPath: t.lockPath, runBaseline: t.run })).rejects.toThrow(/genesis/);
    expect(historyProblems(m).join(" ")).toMatch(/genesis/);
  });

  it("breaks the chain when a data file AND its manifest hash are hand-edited together", async () => {
    const t = setup();
    writeFileSync(join(t.dir, "queries.jsonl"), "sneaky\n");
    const m = t.read();
    m.files["queries.jsonl"] = sha("sneaky\n");
    writeFileSync(join(t.dir, "manifest.json"), JSON.stringify(m));
    await expect(applyLock({ dataDir: t.dir, lockPath: t.lockPath, runBaseline: t.run })).rejects.toThrow(/history is inconsistent/);
    expect(t.run).not.toHaveBeenCalled();
  });

  it("refuses when manifest.files does not cover every data file in the directory (dropped key or new file)", async () => {
    const t = setup();
    writeFileSync(join(t.dir, "extra.jsonl"), "unlisted\n");
    await expect(applyLock({ dataDir: t.dir, lockPath: t.lockPath, runBaseline: t.run })).rejects.toThrow(/extra\.jsonl/);
    const t2 = setup();
    const m = t2.read();
    m.files = {};
    writeFileSync(join(t2.dir, "manifest.json"), JSON.stringify(m));
    await expect(applyLock({ dataDir: t2.dir, lockPath: t2.lockPath, runBaseline: t2.run })).rejects.toBeInstanceOf(LockRefused);
    expect(t.run).not.toHaveBeenCalled();
  });

  it("hashDataDir hashes every .jsonl in the directory, sorted", () => {
    const t = setup();
    writeFileSync(join(t.dir, "b.jsonl"), "b");
    expect(Object.keys(hashDataDir(t.dir))).toEqual(["b.jsonl", "queries.jsonl"]);
    expect(hashDataDir(t.dir)["queries.jsonl"]).toBe(sha("v1\n"));
  });
});

describe("compareToLock (what the Task 11 tripwire uses)", () => {
  const r = (ids: string[], overrides: Record<string, string[]> = {}, fp: Record<string, string> = { "q.jsonl": "h" }): VariantReport =>
    ({ ...report(), dataFingerprint: fp, results: ids.map(id => ({ ...report().results[0], queryId: id, rankedIds: overrides[id] ?? ["a"] })) });

  it("aligns by queryId, so inserting a query does not shift every later comparison", () => {
    const lock = r(["q1", "q2", "q3"]);
    const now = r(["q1", "qNEW", "q2", "q3"]);
    const d = compareToLock(lock, now);
    expect(d.changed).toEqual([]);
    expect(d.extra).toEqual(["qNEW"]);
    expect(d.missing).toEqual([]);
  });

  it("reports changed rankings, missing queries, and a fingerprint mismatch", () => {
    const d = compareToLock(r(["q1", "q2"]), r(["q1", "q3"], { q1: ["z"] }, { "q.jsonl": "other" }));
    expect(d.changed).toEqual(["q1"]);
    expect(d.missing).toEqual(["q2"]);
    expect(d.extra).toEqual(["q3"]);
    expect(d.fingerprintMismatch).toBe(true);
    expect(compareToLock(r(["q1"]), r(["q1"])).fingerprintMismatch).toBe(false);
  });
});
