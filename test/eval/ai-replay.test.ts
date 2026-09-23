import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  NeuronBudget, ReplayMissError, ReplayStore, estimateNeurons, makeReplayAi, makeRestAi, replayKey, stableStringify,
} from "./ai-replay";

const MODEL = "@cf/baai/bge-small-en-v1.5";
const tmp = () => mkdtempSync(join(tmpdir(), "eval-replay-"));
const embedInput = (t: string) => ({ text: [t] });

function fakeLive(vec = [0.25, -0.5]) {
  return { run: vi.fn(async () => ({ data: [vec] })) };
}

describe("replayKey", () => {
  it("ignores object key order and separates models", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(replayKey(MODEL, embedInput("x"))).toBe(replayKey(MODEL, { text: ["x"] }));
    expect(replayKey(MODEL, embedInput("x"))).not.toBe(replayKey("@cf/baai/bge-m3", embedInput("x")));
    expect(replayKey(MODEL, embedInput("x"))).not.toBe(replayKey(MODEL, embedInput("y")));
  });

  it("is stable across runs (pinned digest)", () => {
    const key = replayKey(MODEL, embedInput("x"));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(replayKey(MODEL, JSON.parse(JSON.stringify(embedInput("x")))));
    expect(key).toBe(createHash("sha256").update(MODEL).update("\0").update('{"text":["x"]}').digest("hex"));
  });
});

describe("makeReplayAi", () => {
  it("replay mode fails closed on an embedding miss and never touches the network", async () => {
    const fetchImpl = vi.fn(() => { throw new Error("network must not be used"); });
    const store = new ReplayStore([], undefined);
    const { ai } = makeReplayAi({ store, mode: "replay", live: makeRestAi({ accountId: "a", apiToken: "t", fetchImpl: fetchImpl as never }) });
    await expect(ai.run(MODEL as never, embedInput("nope") as never)).rejects.toBeInstanceOf(ReplayMissError);
    await expect(ai.run(MODEL as never, embedInput("nope") as never)).rejects.toThrow(
      new RegExp(`${MODEL}.*${replayKey(MODEL, embedInput("nope"))}`),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("record mode calls live once, persists, and serves the same value from cache afterwards", async () => {
    const dir = tmp();
    const live = fakeLive([0.1, 0.2, 0.3]);
    const budget = new NeuronBudget(1000);
    const first = makeReplayAi({ store: new ReplayStore([], join(dir, "c.jsonl")), mode: "record", live, budget });
    const a = await first.ai.run(MODEL as never, embedInput("hello world") as never) as unknown as { data: number[][] };
    expect(live.run).toHaveBeenCalledTimes(1);
    await first.ai.run(MODEL as never, embedInput("hello world") as never);
    expect(live.run).toHaveBeenCalledTimes(1); // second call is a cache hit
    expect(readFileSync(join(dir, "c.jsonl"), "utf8").trim().split("\n")).toHaveLength(1); // written once
    expect(a.data[0][0]).toBeCloseTo(0.1, 6); // float32 round trip
    expect(budget.spent).toBeGreaterThan(0);

    // A fresh process: read-only replay of the file recorded above.
    const second = makeReplayAi({ store: new ReplayStore([join(dir, "c.jsonl")]), mode: "replay" });
    const b = await second.ai.run(MODEL as never, embedInput("hello world") as never) as unknown as { data: number[][] };
    expect(b).toEqual(a); // record returns the decoded value, so both paths agree exactly
    expect(second.drainCalls()).toMatchObject([{ kind: "embedding", source: "replay" }]);
    expect(second.drainCalls()).toEqual([]); // drained
  });

  it("refuses to spend past the neuron budget, before the call", async () => {
    const live = fakeLive();
    const { ai } = makeReplayAi({ store: new ReplayStore([], join(tmp(), "c.jsonl")), mode: "record", live, budget: new NeuronBudget(0.0001) });
    await expect(ai.run(MODEL as never, embedInput("x".repeat(4000)) as never)).rejects.toThrow(/budget/);
    expect(live.run).not.toHaveBeenCalled();
  });

  it("stubs an LLM miss with an empty stream in replay mode and says so", async () => {
    const replay = makeReplayAi({ store: new ReplayStore([]), mode: "replay" });
    const stream = await replay.ai.run("@cf/meta/llama-4-scout-17b-16e-instruct" as never, { messages: [{ role: "user", content: "hi" }], stream: true } as never) as ReadableStream;
    const text = await new Response(stream).text();
    expect(text).toBe("data: [DONE]\n\n");
    expect(replay.drainCalls()).toMatchObject([{ kind: "llm", source: "stub" }]);
  });

  it("dry mode records the miss with a neuron estimate and answers with a hash vector", async () => {
    const replay = makeReplayAi({ store: new ReplayStore([]), mode: "dry" });
    const out = await replay.ai.run(MODEL as never, embedInput("some text") as never) as unknown as { data: number[][] };
    expect(out.data[0]).toHaveLength(384);
    expect([...replay.misses.values()]).toMatchObject([{ model: MODEL, neurons: expect.any(Number) }]);
  });

  it("reads gzipped committed caches", async () => {
    const dir = tmp();
    const key = replayKey(MODEL, embedInput("z"));
    const f32 = Buffer.from(new Float32Array([1, 2]).buffer).toString("base64");
    writeFileSync(join(dir, "c.jsonl.gz"), gzipSync(`${JSON.stringify({ k: key, v: { f32: [f32] } })}\n`));
    const { ai } = makeReplayAi({ store: new ReplayStore([join(dir, "c.jsonl.gz")]), mode: "replay" });
    expect(await ai.run(MODEL as never, embedInput("z") as never)).toEqual({ data: [[1, 2]] });
  });

  it("exports exactly the keys a run used, readable back as a committed layer", async () => {
    const dir = tmp();
    const record = makeReplayAi({ store: new ReplayStore([], join(dir, "all.jsonl")), mode: "record", live: fakeLive([1, 2]), budget: new NeuronBudget(1000) });
    await record.ai.run(MODEL as never, embedInput("used") as never);
    await record.ai.run(MODEL as never, embedInput("unused") as never);
    const reader = new ReplayStore([join(dir, "all.jsonl")]);
    await makeReplayAi({ store: reader, mode: "replay" }).ai.run(MODEL as never, embedInput("used") as never);
    expect(reader.exportUsed(join(dir, "core.jsonl.gz"))).toBe(1);
    expect(new ReplayStore([join(dir, "core.jsonl.gz")]).size).toBe(1);
  });
});

describe("estimateNeurons", () => {
  it("throws for a model with no rate so a new model cannot hide its cost", () => {
    expect(() => estimateNeurons("@cf/unknown/model", "x")).toThrow(/NEURON_RATES/);
    expect(estimateNeurons(MODEL, "a".repeat(4000))).toBeCloseTo((1000 * 1841) / 1e6, 9);
    expect(estimateNeurons(MODEL, "東京".repeat(500))).toBeCloseTo((1000 * 1841) / 1e6, 9); // CJK counts about 1 token per character
  });
});

describe("makeRestAi", () => {
  it("retries 429 with backoff, sends the token only in the header, and never echoes it in errors", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      if (calls.length === 1) return new Response("{}", { status: 429 });
      return new Response(JSON.stringify({ success: true, result: { data: [[1]] } }), { status: 200 });
    });
    const live = makeRestAi({ accountId: "acct", apiToken: "SECRET-TOKEN", fetchImpl: fetchImpl as never });
    vi.useFakeTimers();
    const pending = live.run(MODEL, embedInput("x"));
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toEqual({ data: [[1]] });
    vi.useRealTimers();
    expect(fetchImpl.mock.calls[0][0]).toContain("/accounts/acct/ai/run/@cf/baai/bge-small-en-v1.5");
    expect((calls[0].headers as Record<string, string>).Authorization).toBe("Bearer SECRET-TOKEN");

    const failing = makeRestAi({ accountId: "acct", apiToken: "SECRET-TOKEN", maxRetries: 0,
      fetchImpl: (async () => new Response(JSON.stringify({ success: false, errors: [{ message: "bad" }] }), { status: 400 })) as never });
    await expect(failing.run(MODEL, embedInput("x"))).rejects.toThrow(/bad/);
    await expect(failing.run(MODEL, embedInput("x"))).rejects.not.toThrow(/SECRET-TOKEN/);
  });
});
