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
    for (const token of ["#149", "v1.9", "2024", "err_tls_90412", "40mg/day", "32%"]) {
      expect(shouldRerank("on", close, [token])).toBe("exact-id");
      expect(shouldRerank("auto", close, [token])).toBe("exact-id");
    }
  });
  it("does not mistake prose for an identifier: trailing punctuation and plain hyphenated words are words", () => {
    for (const token of ["cells.", "cancer.", "tissue-resident", "non-infertile", "n-oxide", "apoe", "(cells)."]) {
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
  it("ships at full weight: the worst-ranked scores zero and the best doubles", () => {
    const out = blendRerankerScores([m("a", 1), m("b", 1)], new Map([["a", 0], ["b", 1]]));
    expect(out.map(x => [x.id, x.score])).toEqual([["b", 2], ["a", 0]]);
  });
  it("uses the parent id, not the chunk id, to look up the percentile", () => {
    const out = blendRerankerScores([m("p-0", 1, "p"), m("q", 1)], new Map([["p", 0]]), 0.25);
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
