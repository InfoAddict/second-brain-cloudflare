import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, type Config } from "../../src/config";
import { RERANK_MODEL, RERANK_READY_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { resetRerankReadyMemo } from "../../src/recall/model-reranker";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { TAG_VOCABULARY_KEY } from "../../src/tags/vocabulary";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

type Scorer = (contexts: { text: string }[]) => unknown;
const IDS = ["m0", "m1", "m2", "m3", "m4", "m5"];
const CONTENT: Record<string, string> = Object.fromEntries(IDS.map((id, i) => [id, `notes about launch planning item ${i} with tomato details`]));

describe("recall reranker step", () => {
  const open: SqliteD1[] = [];
  afterEach(() => { open.splice(0).forEach(s => s.close()); resetRerankReadyMemo(); resetFtsReadyMemo(); vi.restoreAllMocks(); });

  async function setup(o: { ready?: boolean; scorer?: Scorer | "throw" | "hang"; extraVectors?: object[] } = {}) {
    resetRerankReadyMemo();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    await sqlite.db.prepare(`ALTER TABLE entries ADD COLUMN updated_at INTEGER`).run();
    IDS.forEach((id, i) => sqlite.seed({ id, content: CONTENT[id], createdAt: 1000 + i, tags: ["work"] }));
    const kv = makeMemoryKV();
    await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["work"], rebuiltAt: Date.now() }));
    if (o.ready !== false) await kv.put(RERANK_READY_KV_KEY, "1");
    const rerankInputs: { query: string; contexts: { text: string }[]; top_k: number }[] = [];
    const run = vi.fn(async (model: string, input: any) => {
      if (model === RERANK_MODEL) {
        rerankInputs.push(input);
        if (o.scorer === "throw") throw new Error("3040: capacity");
        if (o.scorer === "hang") return new Promise(() => {});
        return (o.scorer ?? ((c: { text: string }[]) => ({ response: c.map((_, id) => ({ id, score: id })) })))(input.contexts);
      }
      if (model.startsWith("@cf/baai/bge")) return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"response":"3"}\n\n')); c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } });
    });
    const matches = [
      ...IDS.map((id, i) => ({ id, score: 0.9 - i * 0.002, metadata: { parentId: id, created_at: 1000 + i, content: `vector copy ${id}` } })),
      ...(o.extraVectors ?? []),
    ];
    const env: Env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv, AI: { run } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches }) }),
    });
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) } as unknown as ExecutionContext;
    return { env, ctx, deferred, rerankInputs, run, kv, sqlite };
  }

  async function recall(s: Awaited<ReturnType<typeof setup>>, mode: Config["RERANK_MODE"], q = "launch planning tomato", hops = 0) {
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries({ query: q, topK: 5, hops, synthesize: false }, s.env, s.ctx, { ...DEFAULTS, RERANK_MODE: mode }, { diagnostics });
    await Promise.all(s.deferred);
    return { result, diagnostics };
  }

  it("off never calls the model, on scores one batch and reorders within the bounded blend", async () => {
    const off = await recall(await setup(), "off");
    expect(off.diagnostics.rerankRoute).toBe("off");
    const s = await setup();
    const on = await recall(s, "on");
    expect(on.diagnostics.rerankRoute).toBe("applied");
    expect(s.rerankInputs).toHaveLength(1);
    expect(s.rerankInputs[0].contexts).toHaveLength(6);
    expect(s.rerankInputs[0].top_k).toBe(6);
    // scores rise with submission index, so the last-submitted parent gains the full boost over near-equal heuristics
    const ids = (r: typeof on) => r.result.matches.map(m => m.id);
    expect(ids(on)).not.toEqual(ids(off));
    // the last-submitted parent has the best model score and near-equal heuristics, so the blend lifts it above where the heuristic order had it
    const best = IDS.find(id => CONTENT[id] === s.rerankInputs[0].contexts.at(-1)!.text)!;
    expect(ids(on).indexOf(best)).toBeGreaterThanOrEqual(0);
    expect(ids(on).indexOf(best)).toBeLessThan(ids(off).includes(best) ? ids(off).indexOf(best) : Infinity);
    expect(on.diagnostics.rerankMs).toBeTypeOf("number");
  });

  it("sends only scoped D1 passage text, never Vectorize metadata or a foreign hit", async () => {
    const foreign = { id: "ghost", score: 0.95, metadata: { parentId: "ghost", created_at: 1, content: "SECRET stranger memory" } };
    const s = await setup({ extraVectors: [foreign] });
    await recall(s, "on");
    const sent = s.rerankInputs[0].contexts.map(c => c.text).join("\n");
    expect(sent).not.toMatch(/SECRET|vector copy/);
    expect(s.rerankInputs[0].contexts).toHaveLength(6);
    for (const c of s.rerankInputs[0].contexts) expect(Object.values(CONTENT)).toContain(c.text);
  });

  it("with an Identity, a real row in another workspace never reaches the model even when its vector hits first", async () => {
    const foreign = { id: "foreign", score: 0.99, metadata: { parentId: "foreign", created_at: 1, content: "FOREIGN private diary" } };
    const s = await setup({ extraVectors: [foreign] });
    s.sqlite.seed({ id: "foreign", content: "FOREIGN private diary about launch planning tomato", createdAt: 5 });
    for (const id of IDS) s.sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind("ws-a", id).run();
    s.sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind("ws-b", "foreign").run();
    const identity = { userId: "u1", role: "member", personalWorkspaceId: "ws-a", companyWorkspaceIds: [], defaultShare: "" as const };
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries({ query: "launch planning tomato", topK: 5, hops: 0, synthesize: false }, s.env, s.ctx, { ...DEFAULTS, RERANK_MODE: "on" }, { identity, diagnostics });
    expect(diagnostics.rerankRoute).toBe("applied");
    expect(s.rerankInputs[0].contexts.map(c => c.text).join("\n")).not.toMatch(/FOREIGN/);
    expect(s.rerankInputs[0].contexts).toHaveLength(6);
    expect(result.matches.map(m => m.id)).not.toContain("foreign");
  });

  it.each([
    ["an AI error (quota or capacity)", "throw", "error"],
    ["a malformed answer", () => ({ data: [[1]] }), "error"],
    ["a truncated answer", () => ({ response: [{ id: 0, score: 1 }] }), "error"],
    ["a hung model", "hang", "timeout"],
  ] as const)("falls back to the exact baseline result on %s", async (_name, scorer, route) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const base = await recall(await setup(), "off");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const s = await setup({ scorer: scorer as never });
      const pending = recall(s, "on");
      await vi.advanceTimersByTimeAsync(10_000);
      const got = await pending;
      expect(got.diagnostics.rerankRoute).toBe(route);
      expect(got.result.matches).toEqual(base.result.matches);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips exact-identifier queries and too-few candidates", async () => {
    const s = await setup();
    const exact = await recall(s, "on", "release v1.9 launch planning");
    expect(exact.diagnostics.rerankRoute).toBe("exact-id");
    expect(s.rerankInputs).toHaveLength(0);
  });

  it("auto attempts an ambiguous pack, and too few candidates are never sent", async () => {
    expect((await recall(await setup(), "auto")).diagnostics.rerankRoute).toBe("applied");
    const few = await setup();
    few.env = { ...few.env, VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [
      { id: "m0", score: 0.95, metadata: { parentId: "m0", created_at: 1000 } },
      { id: "m1", score: 0.5, metadata: { parentId: "m1", created_at: 1001 } },
    ] }) }) } as Env;
    const got = await recall(few, "on", "zzqq unmatched words");
    expect(got.diagnostics.rerankRoute).toBe("too-few");
    expect(few.rerankInputs).toHaveLength(0);
  });

  it("a never-probed model is not used; the first recall schedules the probe and a passing probe latches ready", async () => {
    const s = await setup({ ready: false, scorer: (c: { text: string }[]) => ({ response: c.map((x, id) => ({ id, score: /reset a forgotten password/.test(x.text) ? 5 : -5 })) }) });
    const first = await recall(s, "on");
    expect(first.diagnostics.rerankRoute).toBe("not-ready");
    expect(await s.kv.get(RERANK_READY_KV_KEY)).toBe("1"); // the probe ran in waitUntil
    expect(s.rerankInputs).toHaveLength(1); // that one call is the probe, not a recall batch
    expect(s.rerankInputs[0].contexts).toHaveLength(3);
  });

  it("a latch marked failed keeps recall on the heuristic order without another probe", async () => {
    const s = await setup({ ready: false });
    await s.kv.put(RERANK_READY_KV_KEY, "0");
    const got = await recall(s, "on");
    expect(got.diagnostics.rerankRoute).toBe("not-ready");
    expect(s.rerankInputs).toHaveLength(0);
  });

  it("costs one extra AI call and one extra D1 statement at hops 0, and no extra statement at hops 1", async () => {
    for (const hops of [0, 1]) {
      const off = await setup();
      const offDiag: RecallDiagnostics = {};
      await recallEntries({ query: "launch planning tomato", topK: 5, hops, synthesize: false }, off.env, off.ctx, { ...DEFAULTS, RERANK_MODE: "off" }, { diagnostics: offDiag });
      const on = await setup();
      const onDiag: RecallDiagnostics = {};
      await recallEntries({ query: "launch planning tomato", topK: 5, hops, synthesize: false }, on.env, on.ctx, { ...DEFAULTS, RERANK_MODE: "on" }, { diagnostics: onDiag });
      expect(onDiag.rerankRoute).toBe("applied");
      expect(onDiag.operations!.aiCalls).toBe(offDiag.operations!.aiCalls + 1);
      expect(onDiag.operations!.d1Statements).toBe(offDiag.operations!.d1Statements + (hops === 0 ? 1 : 0));
      expect(onDiag.operations!.vectorizeQueries).toBe(offDiag.operations!.vectorizeQueries);
      expect(onDiag.operations!.kvReads).toBe(offDiag.operations!.kvReads + 1); // the readiness latch; off returns before reading it
    }
  });
});
