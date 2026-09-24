import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import type { Config } from "../../src/config";
import type { RecallInternalOptions } from "../../src/recall/types";
import { ReplayStore, makeReplayAi } from "./ai-replay";
import { loadCorpus, type LoadedCorpus } from "./corpus/loader";
import { ACTORS, EVAL_NOW, IDENTITIES, WORKSPACES, type CorpusEntry } from "./corpus/types";
import { EMBEDDING_DIMS } from "./ai-replay";
import { readScopeWorkspaces } from "../../src/lib/scope";
import { vectorizeFilterState } from "../../src/vectorize/scope";
import { ExactVectorize } from "./vectorize-emulator";
import { EVAL_TOP_K, RUNNER_VERSION, findLeaks, freezeClock, readReport, runVariant, writeReport } from "./runner";
import type { EmbeddingProducer, GoldenQuery } from "./types";
import { getVariant, registerVariant, unregisterVariant } from "./variants";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Call = { params: Record<string, unknown>; ctx: ExecutionContext; cfg: Readonly<Config>; internal: RecallInternalOptions; now: number };
const seen: Call[] = [];
let bypassDb: unknown; // drift probe: hand recall the unguarded DB
vi.mock("../../src/recall/search", async (orig) => {
  const actual = await orig<typeof import("../../src/recall/search")>();
  return {
    ...actual,
    recallEntries: (params: Call["params"], env: never, ctx: ExecutionContext, cfg: Readonly<Config>, internal: RecallInternalOptions) => {
      seen.push({ params, ctx, cfg, internal, now: Date.now() });
      return actual.recallEntries(params as never, bypassDb ? { ...(env as object), DB: bypassDb } as never : env, ctx, cfg, internal);
    },
  };
});

const MODEL = "@cf/baai/bge-small-en-v1.5";
const row = (id: string, content: string, ws: keyof typeof WORKSPACES = "avery"): CorpusEntry => ({
  id, content, tags: [], source: "api", createdAt: EVAL_NOW - 86_400_000, workspaceId: WORKSPACES[ws], actorId: ACTORS.avery,
});
const entries = [
  row("a1", "xylo alpha quarterly plan"),
  row("b1", "xylo alpha quarterly plan", "blake"), // decoy: same words, another user's workspace
  row("c1", "shared roadmap for the xylo launch", "company"),
  ...Array.from({ length: 20 }, (_, i) => row(`f${i}`, `weekly gardening note number ${i} about tomatoes`)),
];
const queries: GoldenQuery[] = [
  { id: "q1", category: "rare-word", text: "xylo alpha", gold: [{ id: "a1", grade: 2 }], viewer: "avery" },
  { id: "q2", category: "paraphrase", text: "shared roadmap launch", gold: [{ id: "c1", grade: 2 }], viewer: "avery" },
  { id: "q3", category: "rare-word", text: "xylo alpha", gold: [{ id: "b1", grade: 2 }], viewer: "blake" },
];

let open: LoadedCorpus[] = [];
afterEach(async () => {
  seen.length = 0; bypassDb = undefined; await Promise.all(open.map(c => c.close())); open = []; });

async function corpus(): Promise<LoadedCorpus> {
  const c = await loadCorpus({
    spec: { id: "tiny", intent: "tie", entries, edges: [], queries },
    backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore([]), mode: "dry" }), embeddingModel: MODEL,
  });
  open.push(c);
  return c;
}
const run = (c: LoadedCorpus, name = "baseline", isolate: "warm" | "cold" = "warm") =>
  runVariant({ corpus: c, variant: getVariant(name), queries, isolate, embeddingModel: MODEL });

describe("runVariant", () => {
  it("returns per-query results with real cost fields and no cross-workspace leaks", async () => {
    const report = await run(await corpus());
    expect(report).toMatchObject({ schema: 1, variant: "baseline", corpus: "tiny", d1Backend: "sqlite", isolate: "warm" });
    const [q1, q2, q3] = report.results;
    expect(q1.rankedIds).toContain("a1");
    expect(q1.rankedIds).not.toContain("b1"); // the decoy belongs to another user
    expect(q2.rankedIds).toContain("c1");
    expect(q3.rankedIds).toContain("b1");
    expect(q3.rankedIds).not.toContain("a1");
    expect(report.results.every(r => r.leaked.length === 0 && !r.error)).toBe(true);
    expect(q1.cost).toMatchObject({ embeddingCalls: 1, vectorizeQueries: expect.any(Number), d1RowsRead: null });
    expect(q1.cost.d1Statements).toBeGreaterThan(0);
    expect(q1.cost.neurons).toBeGreaterThan(0);
    expect(q1.ftsRoute).toBe("fts");
    expect(q1.metrics.recall10).toBe(1);
  });

  it("is deterministic: two runs give identical rankings, and the wall clock does not matter", async () => {
    const c = await corpus();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    const first = await run(c);
    vi.setSystemTime(new Date("2040-06-01T00:00:00Z"));
    const second = await run(c);
    vi.useRealTimers();
    expect(second.results.map(r => [r.queryId, r.rankedIds, r.metrics])).toEqual(first.results.map(r => [r.queryId, r.rankedIds, r.metrics]));
  });

  it("freezes Date.now during the run and restores it afterwards", async () => {
    const real = Date.now;
    const restore = freezeClock(EVAL_NOW);
    expect(Date.now()).toBe(EVAL_NOW);
    restore();
    expect(Date.now).toBe(real);
  });

  it("never mutates recall_count, so query order cannot change later results", async () => {
    const c = await corpus();
    await run(c);
    const sum = await c.env.DB.prepare(`SELECT COALESCE(SUM(recall_count), 0) AS n FROM entries`).first<{ n: number }>();
    expect(sum!.n).toBe(0);
  });

  it("routes each built-in variant the way its description says", async () => {
    const c = await corpus();
    expect((await run(c, "baseline")).results[0].ftsRoute).toBe("fts");
    expect((await run(c, "like")).results[0].ftsRoute).toBe("like-not-ready");
    expect((await run(c, "dense-only")).results[0].ftsRoute).toBe("skipped-by-variant");
    const keywordOnly = await run(c, "keyword-only");
    expect(keywordOnly.results[0].cost).toMatchObject({ embeddingCalls: 0, vectorizeQueries: 0 });
    expect(keywordOnly.results[0].rankedIds).toContain("a1");
    expect((await run(c, "baseline")).results[0].ftsRoute).toBe("fts"); // ready flag restored per run
  });

  it("records a per-query error instead of aborting the run, and scores it as a miss", async () => {
    const c = await corpus();
    const empty = makeReplayAi({ store: new ReplayStore([]), mode: "replay" });
    (c.env as { AI: unknown }).AI = empty.ai;
    (c as { replay: unknown }).replay = empty;
    const report = await run(c);
    expect(report.results[0].error).toMatch(/replay cache miss/);
    expect(report.results[0].rankedIds).toEqual([]);
    expect(report.results[0].metrics.recall10).toBe(0);
  });

  it("refuses to run a variant whose index-time build differs from the loaded corpus", async () => {
    const c = await corpus();
    await expect(runVariant({ corpus: c, variant: { name: "ctx", description: "x", index: { id: "contextual-embed", storeEntry: (async () => { throw new Error("unused"); }) as never } }, queries, isolate: "warm", embeddingModel: MODEL }))
      .rejects.toThrow(/index/);
  });

  it("round-trips a report through JSON", async () => {
    const report = await run(await corpus());
    const path = join(mkdtempSync(join(tmpdir(), "eval-report-")), "r.json");
    writeReport(path, report);
    expect(readReport(path)).toEqual(report);
  });
});

describe("findLeaks", () => {
  it("flags ids in a workspace the viewer cannot read, and ids it cannot place", () => {
    const workspaceOf = new Map([["a", "ws-avery"], ["b", "ws-blake"]]);
    expect(findLeaks(["a", "b", "ghost"], new Set(["ws-avery"]), workspaceOf)).toEqual(["b", "ghost"]);
  });
});

describe("runner determinism rules", () => {
  it("runs recall with the default config and freezes Date.now at EVAL_NOW for every call", async () => {
    const c = await corpus();
    await c.env.OAUTH_KV.put("config:overrides", JSON.stringify({ DEFAULT_HOPS: 3, KEYWORD_CANDIDATE_LIMIT: 1 }));
    await run(c);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.cfg).toEqual({ ...DEFAULTS, EMBEDDING_MODEL: MODEL });
      expect(Object.isFrozen(call.cfg)).toBe(true);
      expect(call.now).toBe(EVAL_NOW);
    }
  });

  it("hands recall a waitUntil that does nothing and never synthesizes", async () => {
    const c = await corpus();
    await run(c);
    for (const call of seen) {
      expect(call.params).toMatchObject({ topK: 10, synthesize: false });
      const ran = vi.fn();
      expect(call.ctx.waitUntil(Promise.resolve().then(ran))).toBeUndefined();
      expect(Object.keys(call.ctx)).toEqual(["waitUntil"]);
    }
  });

  it("runs queries sequentially in file order and reports in that order", async () => {
    const c = await corpus();
    const order: string[] = [];
    const report = await runVariant({ corpus: c, variant: getVariant("baseline"), queries, isolate: "cold", embeddingModel: MODEL, onProgress: (d) => order.push(String(d)) });
    expect(report.results.map(r => r.queryId)).toEqual(["q1", "q2", "q3"]);
    expect(order).toEqual(["1", "2", "3"]);
  });

  it("does not synthesize: no LLM call reaches the AI binding", async () => {
    const c = await corpus();
    const report = await run(c);
    expect(report.results.every(r => r.cost.aiCalls === r.cost.embeddingCalls)).toBe(true);
  });

  it("warm mode pre-warms per viewer and scores each query once; cold mode pays the readiness read every query", async () => {
    const c = await corpus();
    const warm = await run(c, "baseline", "warm");
    const cold = await run(c, "baseline", "cold");
    expect(warm.results).toHaveLength(3);
    expect(seen.length).toBe(2 + 3 + 3); // two viewers warmed once, then 3 scored, then 3 cold
    // the only difference is the readiness flag read, which cold repeats on every query
    expect(cold.results.map((r, i) => r.cost.kvReads - warm.results[i].cost.kvReads)).toEqual([1, 1, 1]);
    expect(cold.results.map(r => r.rankedIds)).toEqual(warm.results.map(r => r.rankedIds));
  });

  it("flags a leak when recall returns an id the viewer cannot read", async () => {
    const c = await corpus();
    c.workspaceOf.set("a1", WORKSPACES.outsider); // mislabel a1 so a legitimate hit looks foreign
    const report = await run(c);
    expect(report.results[0].leaked).toContain("a1");
  });

  it.skipIf(!process.env.EVAL_WORKERD)("workerd reports real rows_read", async () => {
    const c = await loadCorpus({
      spec: { id: "tiny", intent: "tie", entries, edges: [], queries },
      backend: "workerd", replay: makeReplayAi({ store: new ReplayStore([]), mode: "dry" }), embeddingModel: MODEL,
    });
    open.push(c);
    const report = await run(c);
    expect(report.results.every(r => typeof r.cost.d1RowsRead === "number" && r.cost.d1RowsRead > 0)).toBe(true);
 }, 30_000); // workerd startup is slow under parallel load
});

describe("leak sentinel", () => {
  it("flags an unplaceable id even for an admin whose readable set contains the empty string", () => {
    const readable = new Set(readScopeWorkspaces(IDENTITIES.avery));
    expect(readable.has("")).toBe(true); // premise: the admin identity's default share is ""
    expect(findLeaks(["ghost"], readable, new Map())).toEqual(["ghost"]);
  });
});

describe("degraded recalls", () => {
  const dead = (c: LoadedCorpus) => { (c.vectorize as unknown as { query: unknown }).query = async () => { throw new Error("vectorize down"); }; };

  it("records a dead dense arm on the query instead of reporting a clean run", async () => {
    const c = await corpus();
    dead(c);
    const report = await run(c);
    expect(report.results.every(r => !r.error)).toBe(true);
    expect(report.results.every(r => r.degraded?.includes("semantic-unavailable"))).toBe(true);
  });

  it("records a rejected workspace filter as degraded", async () => {
    const c = await corpus();
    (c.env as { VECTORIZE: unknown }).VECTORIZE = new ExactVectorize({ dimensions: EMBEDDING_DIMS[MODEL]!, indexedProperties: [] });
    const report = await run(c);
    expect(report.results.every(r => r.degraded?.includes("vectorize-filter-unfiltered"))).toBe(true);
  });

  it("records an FTS failure that fell back to LIKE as degraded", async () => {
    const c = await corpus();
    await c.env.DB.prepare(`DROP TABLE entries_fts`).run(); // the ready flag still says fts
    const report = await run(c);
    expect(report.results[0].ftsRoute).toBe("like-error");
    expect(report.results.every(r => r.degraded?.includes("fts-error"))).toBe(true);
  });

  it("leaves a healthy run with no degradation", async () => {
    const report = await run(await corpus());
    expect(report.results.map(r => r.degraded)).toEqual([[], [], []]);
  });
});

describe("report identity", () => {
  it("carries clusterKey into the report and defaults it to the query id", async () => {
    const c = await corpus();
    const qs: GoldenQuery[] = [{ ...queries[0], clusterKey: "grp" }, queries[1]];
    const report = await runVariant({ corpus: c, variant: getVariant("baseline"), queries: qs, isolate: "warm", embeddingModel: MODEL });
    expect(report.results.map(r => r.clusterKey)).toEqual(["grp", "q2"]);
  });

  it("records the top-k and runner version so reports from different harnesses are not compared", async () => {
    const report = await run(await corpus());
    expect(report).toMatchObject({ topK: EVAL_TOP_K, runnerVersion: RUNNER_VERSION });
  });
});

describe("model producers in the report", () => {
  const mk = (repo: string): EmbeddingProducer => ({ kind: "local-transformers-js", library: "@huggingface/transformers", libraryVersion: "4.3.0", onnxRuntime: "onnxruntime-node@1.30.0", repo, revision: "abc", dtype: "fp32" });

  it("carries the producer of every model the run used, and labels neurons as projected", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-producer-"));
    mkdirSync(join(root, ".eval-cache"), { recursive: true });
    const store = new ReplayStore([], join(root, ".eval-cache", "p.jsonl"), { root });
    store.recordProducer(MODEL, mk("BAAI/bge-small-en-v1.5"));
    store.recordProducer("@cf/baai/bge-reranker-base", mk("BAAI/bge-reranker-base"));
    const replay = makeReplayAi({ store, mode: "dry", dryOther: () => ({ response: [] }) });
    const c = await loadCorpus({ spec: { id: "tiny", intent: "tie", entries, edges: [], queries }, backend: "sqlite", replay, embeddingModel: MODEL });
    open.push(c);
    await replay.ai.run("@cf/baai/bge-reranker-base" as never, { query: "q", contexts: [{ text: "x" }] } as never); // a variant that reranks
    const report = await run(c);
    expect(report.producers).toEqual({ [MODEL]: mk("BAAI/bge-small-en-v1.5"), "@cf/baai/bge-reranker-base": mk("BAAI/bge-reranker-base") });
    expect(report.neuronSource).toBe("projected");
  });

  it("is empty, with provider-sourced neurons, when the cache names no producer", async () => {
    const report = await run(await corpus());
    expect(report.producers ?? {}).toEqual({});
    expect(report.neuronSource).toBe("provider");
  });
});

describe("isolate hygiene", () => {
  const strict = async () => {
    const c = await corpus();
    (c.env as { VECTORIZE: unknown }).VECTORIZE = new ExactVectorize({ dimensions: EMBEDDING_DIMS[MODEL]!, indexedProperties: [] });
    return c;
  };
  const probes = (r: Awaited<ReturnType<typeof run>>) => r.results.map(x => x.cost.vectorizeQueries);

  it("starts every run with a fresh Vectorize filter latch", async () => {
    const a = await run(await strict());
    expect(a.results.every(r => r.degraded?.includes("vectorize-filter-unfiltered"))).toBe(true);
    expect(vectorizeFilterState().supported).toBe(false); // the first run left the latch tripped
    const b = await run(await corpus()); // a healthy index must not inherit that state
    expect(b.results.map(r => r.degraded)).toEqual([[], [], []]);
  });

  it("cold mode re-probes the filter on every query; warm mode learns it once", async () => {
    const c = await strict();
    const warm = await run(c, "baseline", "warm");
    const cold = await run(c, "baseline", "cold");
    expect(probes(warm).every(n => n === 1)).toBe(true);
    expect(probes(cold).every(n => n === 2)).toBe(true);
  });

  it("restores Date.now even when the run itself throws", async () => {
    const c = await corpus();
    const real = Date.now;
    vi.spyOn(c.env.OAUTH_KV, "put").mockRejectedValue(new Error("kv down"));
    await expect(run(c)).rejects.toThrow(/kv down/);
    expect(Date.now).toBe(real);
    vi.restoreAllMocks();
  });
});

describe("seam and guard", () => {
  it("fts-orderless reaches recall as keywordPreRankedOverride=false; baseline leaves it unset", async () => {
    const c = await corpus();
    await run(c, "fts-orderless");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(x => x.internal.keywordPreRankedOverride === false)).toBe(true);
    seen.length = 0;
    await run(c, "baseline");
    expect(seen.every(x => x.internal.keywordPreRankedOverride === undefined)).toBe(true);
  });

  it("fails the run at the point of breakage if the recall_count write stops being intercepted", async () => {
    const c = await corpus();
    bypassDb = c.env.DB;
    await expect(run(c)).rejects.toThrow(/recall_count/);
  });
});

describe("variant registry", () => {
  it("registers, resolves and unregisters a variant; refuses duplicates and builtins", () => {
    registerVariant({ name: "tmp-x", description: "x" });
    expect(getVariant("tmp-x").name).toBe("tmp-x");
    expect(() => registerVariant({ name: "tmp-x", description: "y" })).toThrow(/already/);
    unregisterVariant("tmp-x");
    expect(() => getVariant("tmp-x")).toThrow(/unknown variant/);
    expect(() => unregisterVariant("baseline")).toThrow(/builtin/);
    expect(() => registerVariant({ name: "baseline", description: "z" })).toThrow(/already/);
  });
});
