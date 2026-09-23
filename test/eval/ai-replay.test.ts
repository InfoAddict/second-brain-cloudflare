import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  NeuronBudget, ReplayMissError, ReplayStore, estimateNeurons, estimateTokens, makeReplayAi, makeRestAi, replayKey, stableStringify,
} from "./ai-replay";

const MODEL = "@cf/baai/bge-small-en-v1.5";
const LLM = "@cf/meta/llama-4-scout-17b-16e-instruct";
// A throwaway repo root: working caches live in <root>/.eval-cache, the committed layer in <root>/test/eval/data/core.
const tmp = () => {
  const root = mkdtempSync(join(tmpdir(), "eval-replay-"));
  mkdirSync(join(root, ".eval-cache"), { recursive: true });
  return root;
};
const cacheOf = (root: string) => join(root, ".eval-cache");
const store = (root: string, file: string, extra: { lockStaleMs?: number } = {}) => new ReplayStore([], join(cacheOf(root), file), { root, ...extra });
const rows = (file: string) => readFileSync(file, "utf8").trim().split("\n");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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
    const root = tmp();
    const dir = cacheOf(root);
    const live = fakeLive([0.1, 0.2, 0.3]);
    const budget = new NeuronBudget(1000);
    const first = makeReplayAi({ store: store(root, "c.jsonl"), mode: "record", live, budget });
    const a = await first.ai.run(MODEL as never, embedInput("hello world") as never) as unknown as { data: number[][] };
    expect(live.run).toHaveBeenCalledTimes(1);
    await first.ai.run(MODEL as never, embedInput("hello world") as never);
    expect(live.run).toHaveBeenCalledTimes(1); // second call is a cache hit
    expect(readFileSync(join(dir, "c.jsonl"), "utf8").trim().split("\n")).toHaveLength(1); // written once
    expect(a.data[0][0]).toBeCloseTo(0.1, 6); // float32 round trip
    expect(budget.spent).toBeGreaterThan(0);

    // A fresh process: read-only replay of the file recorded above.
    const second = makeReplayAi({ store: new ReplayStore([join(dir, "c.jsonl")], undefined, { root }), mode: "replay" });
    const b = await second.ai.run(MODEL as never, embedInput("hello world") as never) as unknown as { data: number[][] };
    expect(b).toEqual(a); // record returns the decoded value, so both paths agree exactly
    expect(second.drainCalls()).toMatchObject([{ kind: "embedding", source: "replay" }]);
    expect(second.drainCalls()).toEqual([]); // drained
  });

  it("refuses to spend past the neuron budget, before the call", async () => {
    const live = fakeLive();
    const { ai } = makeReplayAi({ store: store(tmp(), "c.jsonl"), mode: "record", live, budget: new NeuronBudget(0.0001) });
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
    const root = tmp();
    const dir = cacheOf(root);
    const key = replayKey(MODEL, embedInput("z"));
    const f32 = Buffer.from(new Float32Array([1, 2]).buffer).toString("base64");
    writeFileSync(join(dir, "c.jsonl.gz"), gzipSync(`${JSON.stringify({ k: key, v: { f32: [f32] } })}\n`));
    const { ai } = makeReplayAi({ store: new ReplayStore([join(dir, "c.jsonl.gz")], undefined, { root }), mode: "replay" });
    expect(await ai.run(MODEL as never, embedInput("z") as never)).toEqual({ data: [[1, 2]] });
  });

  it("exports exactly the keys a run used, readable back as a committed layer", async () => {
    const root = tmp();
    const dir = cacheOf(root);
    const record = makeReplayAi({ store: store(root, "all.jsonl"), mode: "record", live: fakeLive([1, 2]), budget: new NeuronBudget(1000) });
    await record.ai.run(MODEL as never, embedInput("used") as never);
    await record.ai.run(MODEL as never, embedInput("unused") as never);
    const reader = new ReplayStore([join(dir, "all.jsonl")], undefined, { root });
    await makeReplayAi({ store: reader, mode: "replay" }).ai.run(MODEL as never, embedInput("used") as never);
    expect(reader.exportUsed(join(dir, "core.jsonl.gz"))).toBe(1);
    expect(new ReplayStore([join(dir, "core.jsonl.gz")], undefined, { root }).size).toBe(1);
  });
});

describe("estimateNeurons", () => {
  it("throws for a model with no rate so a new model cannot hide its cost", () => {
    expect(() => estimateNeurons("@cf/unknown/model", "x")).toThrow(/NEURON_RATES/);
    expect(estimateNeurons(MODEL, "a".repeat(4000))).toBeCloseTo((4000 * 1841) / 1e6, 9); // one token per UTF-8 byte
  });
});

describe("durability", () => {
  const good = (k: string) => JSON.stringify({ k, v: { text: k } });

  it("skips a torn final line with a warning and the next append starts on a clean line", () => {
    const root = tmp();
    const file = join(cacheOf(root), "torn.jsonl");
    writeFileSync(file, `${good("a")}\n{"k":"torn"`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = new ReplayStore([], file, { root });
    expect(s.size).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("torn.jsonl"));
    warn.mockRestore();
    s.put("b", { text: "b" });
    const lines = rows(file);
    expect(lines.map(l => JSON.parse(l).k)).toEqual(["a", "b"]);
    expect(new ReplayStore([file], undefined, { root }).size).toBe(2);
  });

  it("tolerates a torn tail in a read-only layer without touching the file", () => {
    const root = tmp();
    const file = join(cacheOf(root), "ro.jsonl");
    const content = `${good("a")}\n{"k":"tor`;
    writeFileSync(file, content);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(new ReplayStore([file], undefined, { root }).size).toBe(1);
    vi.restoreAllMocks();
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("throws on a corrupt non-final line and names it", () => {
    const root = tmp();
    const file = join(cacheOf(root), "bad.jsonl");
    writeFileSync(file, `${good("a")}\n{"k":"broken"\n${good("c")}\n`);
    expect(() => new ReplayStore([file], undefined, { root })).toThrow(/bad\.jsonl:2/);
  });

  it("exports through a temp file and rename, leaving no temp behind and replacing an old export whole", () => {
    const root = tmp();
    const out = join(cacheOf(root), "core.jsonl.gz");
    writeFileSync(out, "stale, not even gzip");
    const s = store(root, "all.jsonl");
    s.put("k1", { text: "v" });
    s.get("k1");
    expect(s.exportUsed(out)).toBe(1);
    expect(new ReplayStore([out], undefined, { root }).size).toBe(1);
    expect(readdirSync(cacheOf(root)).filter(f => f.includes("tmp"))).toEqual([]);
  });
});

describe("single flight", () => {
  it("coalesces concurrent same-key record calls in one process into one live call and one row", async () => {
    const root = tmp();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const live = { run: vi.fn(async () => { await gate; return { data: [[0.5]] }; }) };
    const replay = makeReplayAi({ store: store(root, "c.jsonl"), mode: "record", live });
    const a = replay.ai.run(MODEL as never, embedInput("same") as never);
    const b = replay.ai.run(MODEL as never, embedInput("same") as never);
    await sleep(20);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb).toEqual(ra);
    expect(live.run).toHaveBeenCalledTimes(1);
    expect(rows(join(cacheOf(root), "c.jsonl"))).toHaveLength(1);
    expect(replay.drainCalls().map(c => c.source).sort()).toEqual(["live", "replay"]);
  });

  it("makes one live call across two store instances on one file (cross-process lock plus recheck)", async () => {
    const root = tmp();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const live = { run: vi.fn(async () => { await gate; return { data: [[0.5]] }; }) };
    const first = makeReplayAi({ store: store(root, "c.jsonl"), mode: "record", live });
    const second = makeReplayAi({ store: store(root, "c.jsonl"), mode: "record", live });
    const a = first.ai.run(MODEL as never, embedInput("same") as never);
    const b = second.ai.run(MODEL as never, embedInput("same") as never);
    await sleep(80);
    release();
    await Promise.all([a, b]);
    expect(live.run).toHaveBeenCalledTimes(1);
    expect(rows(join(cacheOf(root), "c.jsonl"))).toHaveLength(1);
    expect(readdirSync(cacheOf(root)).filter(f => f.endsWith(".lock"))).toEqual([]);
  });

  it("takes over a stale lock and releases its own lock after a failed live call", async () => {
    const root = tmp();
    const file = join(cacheOf(root), "c.jsonl");
    const lock = `${file}.${replayKey(MODEL, embedInput("x"))}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 1, t: Date.now() - 60_000 }));
    const live = { run: vi.fn(async () => ({ data: [[1]] })) };
    const ok = makeReplayAi({ store: store(root, "c.jsonl", { lockStaleMs: 1000 }), mode: "record", live });
    await ok.ai.run(MODEL as never, embedInput("x") as never);
    expect(live.run).toHaveBeenCalledTimes(1);
    const failing = makeReplayAi({ store: store(root, "c.jsonl"), mode: "record", live: { run: async () => { throw new Error("boom"); } } });
    await expect(failing.ai.run(MODEL as never, embedInput("y") as never)).rejects.toThrow(/boom/);
    expect(readdirSync(cacheOf(root)).filter(f => f.endsWith(".lock"))).toEqual([]);
  });
});

describe("path containment", () => {
  it("rejects a working-cache path that traverses out of .eval-cache", () => {
    const root = tmp();
    expect(() => new ReplayStore([], join(cacheOf(root), "..", "leak.jsonl"), { root })).toThrow(/\.eval-cache/);
    expect(existsSync(join(root, "leak.jsonl"))).toBe(false);
  });

  it("rejects absolute paths elsewhere, for the write file and for read layers", () => {
    const root = tmp();
    const elsewhere = join(tmp(), "x.jsonl");
    expect(() => new ReplayStore([], elsewhere, { root })).toThrow(/\.eval-cache/);
    expect(() => new ReplayStore([elsewhere], undefined, { root })).toThrow(/\.eval-cache/);
  });

  it("rejects a symlink that escapes .eval-cache", () => {
    const root = tmp();
    const outside = mkdtempSync(join(tmpdir(), "eval-outside-"));
    symlinkSync(outside, join(cacheOf(root), "link"));
    expect(() => new ReplayStore([], join(cacheOf(root), "link", "x.jsonl"), { root })).toThrow(/\.eval-cache/);
    const s = store(root, "ok.jsonl");
    s.put("k", { text: "v" });
    s.get("k");
    expect(() => s.exportUsed(join(cacheOf(root), "link", "x.jsonl.gz"))).toThrow(/\.eval-cache/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("limits exportUsed to .eval-cache or the committed core data directory", () => {
    const root = tmp();
    const s = store(root, "all.jsonl");
    s.put("k", { text: "v" });
    s.get("k");
    expect(() => s.exportUsed(join(cacheOf(root), "..", "leak.jsonl.gz"))).toThrow(/exportUsed/);
    expect(() => s.exportUsed(join(tmp(), "x.jsonl.gz"))).toThrow(/exportUsed/);
    expect(() => s.exportUsed(join(root, "test/eval/data/other/replay.m.jsonl.gz"))).toThrow(/exportUsed/);
    expect(() => s.exportUsed(join(root, "test/eval/data/core/notes.txt"))).toThrow(/exportUsed/);
    expect(() => s.exportUsed(join(root, "test/eval/data/core/../../leak.jsonl.gz"))).toThrow(/exportUsed/);
    expect(s.exportUsed(join(root, "test/eval/data/core/replay.m.jsonl.gz"))).toBe(1);
  });
});

describe("pricing and token estimates", () => {
  it("prices a 4,000-character LLM response identically in record and replay", async () => {
    const root = tmp();
    const input = { messages: [{ content: "hi" }], stream: false };
    const record = makeReplayAi({ store: store(root, "c.jsonl"), mode: "record", recordLlm: true, budget: new NeuronBudget(1000),
      live: { run: async () => ({ response: "x".repeat(4000) }) } });
    await record.ai.run(LLM as never, input as never);
    const recorded = record.drainCalls()[0].neurons;
    const replay = makeReplayAi({ store: new ReplayStore([join(cacheOf(root), "c.jsonl")], undefined, { root }), mode: "replay" });
    await replay.ai.run(LLM as never, input as never);
    expect(replay.drainCalls()[0].neurons).toBeCloseTo(recorded, 12);
    expect(recorded).toBeCloseTo(estimateNeurons(LLM, "hi", "x".repeat(4000)), 12);
  });

  it("reserves a configured maximum output before the live call and settles to the actual spend", async () => {
    const root = tmp();
    const input = { messages: [{ content: "hi" }], stream: false };
    const live = { run: vi.fn(async () => ({ response: "ok" })) };
    const tight = makeReplayAi({ store: store(root, "a.jsonl"), mode: "record", recordLlm: true, live, maxOutputTokens: 1000, budget: new NeuronBudget(estimateNeurons(LLM, "hi") + 1) });
    await expect(tight.ai.run(LLM as never, input as never)).rejects.toThrow(/budget/);
    expect(live.run).not.toHaveBeenCalled();
    const budget = new NeuronBudget(1000);
    const roomy = makeReplayAi({ store: store(root, "b.jsonl"), mode: "record", recordLlm: true, live, maxOutputTokens: 1000, budget });
    await roomy.ai.run(LLM as never, input as never);
    expect(budget.spent).toBeCloseTo(estimateNeurons(LLM, "hi", "ok"), 12);
  });

  it("refunds the reservation when the live call fails", async () => {
    const budget = new NeuronBudget(1000);
    const record = makeReplayAi({ store: store(tmp(), "c.jsonl"), mode: "record", budget, live: { run: async () => { throw new Error("boom"); } } });
    await expect(record.ai.run(MODEL as never, embedInput("x") as never)).rejects.toThrow(/boom/);
    expect(budget.spent).toBe(0);
  });

  it("never under-counts emoji or CJK against their UTF-8 size", () => {
    for (const text of ["😀".repeat(100), "漢字".repeat(100), "é".repeat(100), "plain ascii text"]) {
      expect(estimateTokens(text)).toBeGreaterThanOrEqual(Buffer.byteLength(text));
    }
    expect(estimateTokens("😀".repeat(1000))).toBe(4000);
  });
});

describe("replay inputs", () => {
  it("rejects non-plain JSON values so distinct wire bodies cannot share a key", () => {
    expect(() => replayKey(MODEL, { d: new Date(0) })).toThrow(/plain JSON.*\$\.d/);
    expect(() => replayKey(MODEL, { m: new Map() })).toThrow(/plain JSON/);
    expect(() => replayKey(MODEL, { s: new Set([1]) })).toThrow(/plain JSON/);
    expect(() => replayKey(MODEL, { n: Number.NaN })).toThrow(/plain JSON/);
    expect(() => replayKey(MODEL, { a: [undefined] })).toThrow(/plain JSON/);
    expect(() => replayKey(MODEL, { f: () => 1 })).toThrow(/plain JSON/);
    expect(() => replayKey(MODEL, { b: 1n })).toThrow(/plain JSON/);
    expect(() => replayKey(MODEL, { t: new Uint8Array(2) })).toThrow(/plain JSON/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => replayKey(MODEL, cyclic)).toThrow(/cycl/);
    expect(replayKey(MODEL, { a: 1, b: undefined })).toBe(replayKey(MODEL, { a: 1 })); // JSON drops undefined properties
    expect(replayKey(MODEL, Object.create(null))).toBe(replayKey(MODEL, {}));
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
