import { afterEach, describe, expect, it, vi } from "vitest";
import { RERANK_MAX_CANDIDATES, RERANK_MODEL, RERANK_READY_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";
import {
  blendRerankerScores, percentilesFromScores, probeReranker, rerankReadiness, resetRerankReadyMemo, scoreRerankCandidates,
  selectRerankIds, shouldRerank, validateRerankerResponse,
} from "../../src/recall/model-reranker";
import type { VectorizeMatch } from "../../src/recall/math";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";

const m = (id: string, score: number, parentId?: string): VectorizeMatch => ({ id, score, metadata: parentId ? { parentId } : {} } as VectorizeMatch);
const aiReturning = (run: (model: string, input: unknown) => Promise<unknown>) => ({ run: vi.fn(run) }) as unknown as Ai;
const envWith = (ai: Ai, kv = makeMemoryKV()): Env => makeTestEnv(undefined, { AI: ai, OAUTH_KV: kv });

afterEach(() => { vi.useRealTimers(); resetRerankReadyMemo(); });

describe("validateRerankerResponse", () => {
  it("rebuilds submitted order from unordered {id, score} rows", () => {
    expect(validateRerankerResponse({ response: [{ id: 2, score: -1.5 }, { id: 0, score: 3 }, { id: 1, score: 0.25 }] }, 3)).toEqual([3, 0.25, -1.5]);
  });
  it.each([
    ["missing response", {}],
    ["null", null],
    ["truncated", { response: [{ id: 0, score: 1 }] }],
    ["duplicate id", { response: [{ id: 0, score: 1 }, { id: 0, score: 2 }] }],
    ["out of range", { response: [{ id: 0, score: 1 }, { id: 2, score: 2 }] }],
    ["negative id", { response: [{ id: -1, score: 1 }, { id: 0, score: 2 }] }],
    ["fractional id", { response: [{ id: 0.5, score: 1 }, { id: 1, score: 2 }] }],
    ["NaN", { response: [{ id: 0, score: Number.NaN }, { id: 1, score: 2 }] }],
    ["Infinity", { response: [{ id: 0, score: Infinity }, { id: 1, score: 2 }] }],
    ["string score", { response: [{ id: 0, score: "1" }, { id: 1, score: 2 }] }],
  ])("rejects %s", (_name, raw) => {
    expect(() => validateRerankerResponse(raw, 2)).toThrow();
  });
});

describe("shouldRerank", () => {
  const close = [1, 0.9, 0.5];
  it("never runs when off, and needs three parents", () => {
    expect(shouldRerank("off", close, ["alpha"])).toBe("off");
    expect(shouldRerank("on", [1, 0.9], ["alpha"])).toBe("too-few");
  });
  it("skips exact-identifier shapes in every mode", () => {
    for (const token of ["#149", "v1.9", "v1.2", "abc123", "err_tls_90412", "config.yaml", "10.0.0.1", "40mg/day", "t2d", "2026-09-24", "eng-1234", "inv-88213", "sn-ax-880415", "err-tls-90412", "pr-42", "20260714-add-ledger-idx", "1999-2005", "registry.example.com/tools/etl:2.81.0", "release-2026.09.88", "1.88.4-beta.3", "billing-88.example.com"]) {
      expect(shouldRerank("on", close, [token])).toBe("exact-id");
      expect(shouldRerank("auto", close, [token])).toBe("exact-id");
    }
  });
  it("does not mistake prose for an identifier: trailing punctuation and plain hyphenated words are words", () => {
    for (const token of ["cells.", "cancer.", "tissue-resident", "non-infertile", "n-oxide", "apoe", "(cells).", "2026", "1999", "32%", "1.5", "3.14", "42", "u.s.", "e.g.", "i.e", "state-of-the-art", "well-known", "first-in-class", "u.s.-based"]) {
      expect(shouldRerank("on", close, [token])).toBe("attempted");
    }
  });
  it("on always attempts; auto only when the runner-up is within 15% of the leader", () => {
    expect(shouldRerank("on", [1, 0.1, 0.05], ["alpha"])).toBe("attempted");
    expect(shouldRerank("auto", [1, 0.86, 0.5], ["alpha"])).toBe("attempted");
    expect(shouldRerank("auto", [1, 0.84, 0.5], ["alpha"])).toBe("clear-leader");
    expect(shouldRerank("auto", [0, 0, 0], ["alpha"])).toBe("clear-leader");
  });
});

describe("percentilesFromScores and blendRerankerScores", () => {
  it("ranks 1 (best) to 0 (worst) and keeps submission order on ties", () => {
    const p = percentilesFromScores(["a", "b", "c"], [0.1, 5, 0.1]);
    expect([p.get("b"), p.get("a"), p.get("c")]).toEqual([1, 0.5, 0]);
  });
  it("is neutral when every score ties", () => {
    expect([...percentilesFromScores(["a", "b"], [2, 2]).values()]).toEqual([0.5, 0.5]);
  });
  it("scales a heuristic score by 1 +/- weight and leaves unscored parents alone", () => {
    const ranked = [m("a", 1), m("b", 0.9), m("z", 0.5)];
    const out = blendRerankerScores(ranked, new Map([["a", 0], ["b", 1]]), 0.25);
    expect(out.map(x => x.id)).toEqual(["b", "a", "z"]);
    expect(out.find(x => x.id === "a")!.score).toBeCloseTo(0.75);
    expect(out.find(x => x.id === "b")!.score).toBeCloseTo(1.125);
    expect(out.find(x => x.id === "z")!.score).toBe(0.5);
    expect(ranked[0].score).toBe(1); // inputs are not mutated
  });
  it("never multiplies by zero: the floor bounds the worst-ranked candidate", () => {
    const out = blendRerankerScores([m("a", 1), m("b", 1)], new Map([["a", 0], ["b", 1]]), 1, 0.25);
    expect(out.map(x => [x.id, x.score])).toEqual([["b", 2], ["a", 0.25]]);
    expect(blendRerankerScores([m("a", 1)], new Map([["a", 0]]), 1, 0.5)[0].score).toBe(0.5);
  });
  it("a scored candidate can never fall below an unscored one, and unscored keep their order", () => {
    const ranked = [m("u1", 10), m("u2", 9), m("a", 1), m("b", 1)];
    const out = blendRerankerScores(ranked, new Map([["a", 0], ["b", 1]]), 1, 0.25);
    expect(out.map(x => x.id)).toEqual(["b", "a", "u1", "u2"]);
    expect(out.find(x => x.id === "a")!.score).toBeGreaterThan(out.find(x => x.id === "u1")!.score);
    expect(out.find(x => x.id === "u1")!.score).toBe(10);
    expect(out.find(x => x.id === "u2")!.score).toBe(9);
    // the lift is one amount for the whole scored block, so the model's own spacing survives
    expect(out.find(x => x.id === "b")!.score - out.find(x => x.id === "a")!.score).toBeCloseTo(1.75);
  });
  it("uses the parent id, not the chunk id, to look up the percentile", () => {
    const out = blendRerankerScores([m("p-0", 1, "p"), m("q", 0.1)], new Map([["p", 0]]), 0.25);
    expect(out.find(x => x.id === "p-0")!.score).toBeCloseTo(0.75);
  });
});

describe("selectRerankIds", () => {
  it("takes 25 direct parents then extra roots up to 30, unique", () => {
    const direct = Array.from({ length: 40 }, (_, i) => m(`d${i}`, 1 - i / 100));
    const root = [m("d0", 1), ...Array.from({ length: 10 }, (_, i) => m(`r${i}`, 0.5))];
    const ids = selectRerankIds(direct, root);
    expect(ids).toHaveLength(RERANK_MAX_CANDIDATES);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 25)).toEqual(direct.slice(0, 25).map(x => x.id));
    expect(ids.slice(25)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });
  it("collapses chunks of one parent", () => {
    expect(selectRerankIds([m("a-0", 1, "a"), m("a-1", 0.9, "a"), m("b", 0.8)], [])).toEqual(["a", "b"]);
  });
});

describe("scoreRerankCandidates", () => {
  const cands = [{ parentId: "a", text: "one" }, { parentId: "b", text: "two" }];
  it("makes one call in the documented request shape", async () => {
    const ai = aiReturning(async () => ({ response: [{ id: 1, score: 2 }, { id: 0, score: -2 }] }));
    expect(await scoreRerankCandidates("q", cands, envWith(ai))).toEqual([-2, 2]);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.run).toHaveBeenCalledWith(RERANK_MODEL, { query: "q", contexts: [{ text: "one" }, { text: "two" }], top_k: 2 });
  });
  it("rejects a malformed answer and an AI error", async () => {
    await expect(scoreRerankCandidates("q", cands, envWith(aiReturning(async () => ({ data: [[1]] }))))).rejects.toThrow();
    await expect(scoreRerankCandidates("q", cands, envWith(aiReturning(async () => { throw new Error("3040: capacity"); })))).rejects.toThrow(/capacity/);
  });
  it("a synchronous throw from AI.run leaves no pending timer", async () => {
    vi.useFakeTimers();
    const ai = { run: () => { throw new Error("binding absent"); } } as unknown as Ai;
    await expect(scoreRerankCandidates("q", cands, envWith(ai))).rejects.toThrow(/binding absent/);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out a hung call and absorbs its late rejection", async () => {
    vi.useFakeTimers();
    let reject!: (e: Error) => void;
    const hung = new Promise<never>((_, r) => { reject = r; });
    const pending = scoreRerankCandidates("q", cands, envWith(aiReturning(() => hung)));
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    reject(new Error("late")); // must not surface as an unhandled rejection
    await vi.advanceTimersByTimeAsync(1);
  });
});

describe("readiness latch and probe", () => {
  const good = (_: string, input: unknown) => {
    const ctxs = (input as { contexts: { text: string }[] }).contexts;
    return Promise.resolve({ response: ctxs.map((c, id) => ({ id, score: /reset a forgotten password/.test(c.text) ? 4 : -6 })) });
  };
  it("reads never-probed, ready and failed, and a KV failure reads not-ready", async () => {
    const kv = makeMemoryKV();
    const env = envWith(aiReturning(good), kv);
    expect(await rerankReadiness(env)).toBeNull();
    resetRerankReadyMemo();
    await kv.put(RERANK_READY_KV_KEY, "1");
    expect(await rerankReadiness(env)).toBe(true);
    resetRerankReadyMemo();
    await kv.put(RERANK_READY_KV_KEY, "0");
    expect(await rerankReadiness(env)).toBe(false);
    resetRerankReadyMemo();
    const broken = { ...kv, get: vi.fn().mockRejectedValue(new Error("kv down")) } as unknown as KVNamespace;
    expect(await rerankReadiness(envWith(aiReturning(good), broken))).toBe(false);
  });
  it("a passing probe latches ready", async () => {
    const kv = makeMemoryKV();
    const res = await probeReranker(envWith(aiReturning(good), kv));
    expect(res.ok).toBe(true);
    expect(await kv.get(RERANK_READY_KV_KEY)).toBe("1");
  });
  it.each([
    ["an AI error", async () => { throw new Error("boom"); }],
    ["a malformed answer", async () => ({ data: [] })],
    ["a model that does not rank the relevant passage first", async (_: string, input: unknown) => ({ response: (input as { contexts: unknown[] }).contexts.map((_c, id) => ({ id, score: 1 })) })],
  ])("a probe failing on %s latches not-ready and never throws", async (_name, run) => {
    const kv = makeMemoryKV();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await probeReranker(envWith(aiReturning(run as never), kv));
    expect(res.ok).toBe(false);
    expect(await kv.get(RERANK_READY_KV_KEY)).toBe("0");
  });
});

describe("production-shaped probe request", () => {
  const good = (_: string, input: unknown) => Promise.resolve({ response: (input as { contexts: { text: string }[] }).contexts.map((c, id) => ({ id, score: /reset a forgotten password/.test(c.text) ? 4 : -6 })) });

  it("sends a full batch of full-length passages after the ranking check", async () => {
    const ai = aiReturning(good);
    expect((await probeReranker(envWith(ai))).ok).toBe(true);
    expect(ai.run).toHaveBeenCalledTimes(2);
    const big = (ai.run as ReturnType<typeof vi.fn>).mock.calls[1][1] as { query: string; contexts: { text: string }[]; top_k: number };
    expect(big.contexts).toHaveLength(30);
    expect(big.contexts.every(c => c.text.length === 400)).toBe(true);
    expect(big.query.length).toBe(256);
    expect(big.top_k).toBe(30);
  });

  it.each([
    ["a rejection", () => { throw new Error("input too large"); }],
    ["a truncated answer", (input: { contexts: unknown[] }) => ({ response: input.contexts.slice(0, 5).map((_c, id) => ({ id, score: 1 })) })],
  ])("latches not-ready when the full batch gets %s", async (_name, onBig) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = makeMemoryKV();
    const ai = aiReturning(async (m, input) => (input as { contexts: unknown[] }).contexts.length === 30 ? (onBig as never as (i: unknown) => unknown)(input) : good(m, input));
    expect((await probeReranker(envWith(ai, kv))).ok).toBe(false);
    expect(await kv.get(RERANK_READY_KV_KEY)).toBe("0");
  });
});

describe("probe latency budget", () => {
  const good = (_: string, input: unknown) => Promise.resolve({ response: (input as { contexts: { text: string }[] }).contexts.map((c, id) => ({ id, score: /reset a forgotten password/.test(c.text) ? 4 : -6 })) });
  const slowBig = (ms: number) => async (m: string, input: unknown) => {
    if ((input as { contexts: unknown[] }).contexts.length === 30) await new Promise(r => setTimeout(r, ms));
    return good(m, input);
  };

  it("latches not-ready when a full batch takes longer than a recall may wait, even though the probe would wait for it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const kv = makeMemoryKV();
    const pending = probeReranker(envWith(aiReturning(slowBig(2000)), kv));
    await vi.advanceTimersByTimeAsync(3000);
    const res = await pending;
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/over the 1500 ms recall budget/);
    expect(await kv.get(RERANK_READY_KV_KEY)).toBe("0");
  });

  it("passes a full batch that answers inside the recall budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const kv = makeMemoryKV();
    const pending = probeReranker(envWith(aiReturning(slowBig(800)), kv));
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).ok).toBe(true);
    expect(await kv.get(RERANK_READY_KV_KEY)).toBe("1");
  });
});

describe("probe herd and KV write failure", () => {
  const good = (_: string, input: unknown) => Promise.resolve({ response: (input as { contexts: { text: string }[] }).contexts.map((c, id) => ({ id, score: /reset a forgotten password/.test(c.text) ? 4 : -6 })) });

  it("concurrent probes share one model call", async () => {
    const ai = aiReturning(good);
    const env = envWith(ai);
    const results = await Promise.all([probeReranker(env), probeReranker(env), probeReranker(env)]);
    expect(results.every(r => r.ok)).toBe(true);
    expect(ai.run).toHaveBeenCalledTimes(2); // one probe = the ranking check plus the full batch
  });

  it("a failed KV put does not make the next readiness read re-probe", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = makeMemoryKV();
    const broken = { ...kv, get: kv.get.bind(kv), put: vi.fn().mockRejectedValue(new Error("kv down")) } as unknown as KVNamespace;
    const env = envWith(aiReturning(good), broken);
    expect((await probeReranker(env)).ok).toBe(true);
    expect(await rerankReadiness(env)).toBe(true); // KV never got the verdict; this isolate remembers it
  });
});
