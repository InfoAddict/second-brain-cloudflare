import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  MODEL_PINS, ModelHashMismatch, countTokens, ensureModelFiles, l2normalize, makeLocalAi, poolBatch, producerFor,
  type EncodedBatch, type EmbedRuntime, type RerankRuntime, type RuntimeLoader,
} from "./local-ai";
import { NEURON_RATES, ReplayStore, makeReplayAi } from "./ai-replay";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

const SMALL = "@cf/baai/bge-small-en-v1.5";
const M3 = "@cf/baai/bge-m3";
const RERANK = "@cf/baai/bge-reranker-base";
const REPO = join(import.meta.dirname, "../..");

/** [batch=2, seq=3, dim=2]; row 1 has one padding token. */
const batch: EncodedBatch = {
  hidden: new Float32Array([3, 4, 1, 1, 9, 9, /* row 2 */ 0, 2, 4, 6, 100, 100]),
  batch: 2, seq: 3, dim: 2, attention: [[1, 1, 1], [1, 1, 0]],
};

describe("pooling and normalization math", () => {
  it("CLS takes token 0 and L2-normalizes", () => {
    const [a, b] = poolBatch(batch, "cls");
    expect([...a]).toEqual([0.6000000238418579, 0.800000011920929]);
    expect([...b]).toEqual([0, 1]);
  });

  it("mean averages only the unmasked tokens, then L2-normalizes", () => {
    const [a, b] = poolBatch(batch, "mean");
    const n1 = Math.hypot((3 + 1 + 9) / 3, (4 + 1 + 9) / 3);
    expect(a[0]).toBeCloseTo(13 / 3 / n1, 6);
    expect(a[1]).toBeCloseTo(14 / 3 / n1, 6);
    const n2 = Math.hypot(2, 4); // (0+4)/2, (2+6)/2; the padded 100s are ignored
    expect(b[0]).toBeCloseTo(2 / n2, 6);
    expect(b[1]).toBeCloseTo(4 / n2, 6);
  });

  it("every pooled row has unit norm, and a zero vector is left alone", () => {
    for (const mode of ["cls", "mean"] as const) for (const v of poolBatch(batch, mode)) expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    expect([...l2normalize(new Float32Array([0, 0]))]).toEqual([0, 0]);
  });

  it("counts real tokens, ignoring padding", () => {
    expect(countTokens(batch.attention)).toBe(5);
  });
});

const DIM = 384; // the real dimension of bge-small; the provider checks it
/** Hidden states for `n` texts of two real tokens each: token 0 is (a, b, 0...), token 1 is (0, ..., c). */
const dimFor = (maxTokens: number) => (maxTokens === 8192 ? 1024 : DIM); // bge-m3 is 1024-d
const hiddenOf = (n: number, tok0: (i: number) => [number, number], c = 1, dim = DIM) => new Float32Array(Array.from({ length: n }, (_, i) => {
  const t0 = new Float32Array(dim), t1 = new Float32Array(dim);
  [t0[0], t0[1]] = tok0(i); t1[dim - 1] = c;
  return [...t0, ...t1];
}).flat());

function stubLoader() {
  const encode = vi.fn(async (texts: string[], _max: number): Promise<EncodedBatch> => ({
    hidden: hiddenOf(texts.length, i => [3 + i, 4], 0, dimFor(_max)), batch: texts.length, seq: 2, dim: dimFor(_max), attention: texts.map(() => [1, 1]),
  }));
  const score = vi.fn(async (_q: string, docs: string[], _max: number) => ({ logits: docs.map((d, i) => (d.includes("good") ? 4 : -4) + i * 0.001), tokens: 7 * docs.length }));
  const loader: RuntimeLoader & { encode: typeof encode; score: typeof score } = {
    embed: vi.fn(async () => ({ encode } as EmbedRuntime)),
    rerank: vi.fn(async () => ({ score } as RerankRuntime)),
    encode, score,
  };
  return loader;
}
const local = (loader: RuntimeLoader) => makeLocalAi({ loader, verify: false, versions: { library: "4.3.0", onnxRuntime: "1.30.0" } });

describe("makeLocalAi response shape and semantics (stubbed runtime, no model)", () => {
  it("returns {shape, data, usage} for a batch, with one vector per text", async () => {
    const loader = stubLoader();
    const res = await local(loader).run(SMALL, { text: ["a", "b", "c"] }) as { shape: number[]; data: number[][]; usage: { prompt_tokens: number; total_tokens: number } };
    expect(res.shape).toEqual([3, DIM]);
    expect(res.data).toHaveLength(3);
    expect(res.usage).toEqual({ prompt_tokens: 6, total_tokens: 6 });
    for (const v of res.data) expect(Math.hypot(...v)).toBeCloseTo(1, 6);
  });

  it("defaults bge-en pooling to mean (Workers AI's default), honors pooling:cls, and pins m3 to cls", async () => {
    const loader = stubLoader();
    loader.encode.mockImplementation(async (_t, max) => ({ hidden: hiddenOf(1, () => [1, 0], 1, dimFor(max)), batch: 1, seq: 2, dim: dimFor(max), attention: [[1, 1]] }));
    const ai = local(loader);
    const dflt = (await ai.run(SMALL, { text: ["x"] }) as { data: number[][] }).data[0];
    const cls = (await ai.run(SMALL, { text: ["x"], pooling: "cls" }) as { data: number[][] }).data[0];
    const m3 = (await ai.run(M3, { text: ["x"], pooling: "mean", truncate_inputs: true }) as { data: number[][] }).data[0];
    expect(dflt[0]).toBeCloseTo(Math.SQRT1_2, 6); // mean of token 0 (1,0,..) and token 1 (..,0,1), normalized
    expect(dflt[DIM - 1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(cls.slice(0, 2)).toEqual([1, 0]);
    expect(cls[DIM - 1]).toBe(0);
    expect(m3.slice(0, 2)).toEqual([1, 0]);
    await expect(ai.run(SMALL, { text: ["x"], pooling: "max" })).rejects.toThrow(/pooling/);
  });

  it("truncates at each model's own token limit and accepts a bare string", async () => {
    const loader = stubLoader();
    const ai = local(loader);
    await ai.run(SMALL, { text: "hello" });
    await ai.run(M3, { text: ["hello"], truncate_inputs: true });
    expect(loader.encode.mock.calls.map(c => c[1])).toEqual([512, 8192]);
  });

  it("rejects models and inputs it cannot serve instead of guessing", async () => {
    const ai = local(stubLoader());
    await expect(ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages: [] })).rejects.toThrow(/no local model/);
    await expect(ai.run(SMALL, { text: [] })).rejects.toThrow(/needs/);
    await expect(ai.run(SMALL, { text: [1] })).rejects.toThrow(/needs/);
    await expect(ai.run(RERANK, { text: ["x"] })).rejects.toThrow(/needs \{query/);
    await expect(ai.run(SMALL, { query: "q", contexts: [{ text: "x" }] })).rejects.toThrow(/needs \{text/);
  });

  it("loads each model once and serializes concurrent calls", async () => {
    const loader = stubLoader();
    let active = 0, peak = 0;
    loader.encode.mockImplementation(async texts => {
      peak = Math.max(peak, ++active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return { hidden: hiddenOf(texts.length, () => [1, 1]), batch: texts.length, seq: 2, dim: DIM, attention: texts.map(() => [1, 1]) };
    });
    const ai = local(loader);
    await Promise.all([1, 2, 3, 4].map(i => ai.run(SMALL, { text: [`t${i}`] })));
    expect(loader.embed).toHaveBeenCalledTimes(1);
    expect(peak).toBe(1);
  });

  it("reranks in Workers AI's response shape: {response: [{id, score}]} best first, raw logits, top_k applied, usage attached", async () => {
    const loader = stubLoader();
    const ai = local(loader);
    const res = await ai.run(RERANK, { query: "q", contexts: [{ text: "meh" }, { text: "good one" }, { text: "bad" }], top_k: 2 }) as { response: { id: number; score: number }[]; usage: { prompt_tokens: number } };
    expect(res.response.map(r => r.id)).toEqual([1, 2]);
    expect(res.response[0].score).toBeCloseTo(4.001, 5); // the raw logit, not a probability
    expect(res.response.some(r => r.score < 0)).toBe(true);
    expect(res.response[0].score).toBeGreaterThan(res.response[1].score);
    expect(res.usage.prompt_tokens).toBe(21);
    expect((await ai.run(RERANK, { query: "q", contexts: [] }) as { response: unknown[] }).response).toEqual([]);
  });

  it("reports the producer with the installed library versions", () => {
    expect(local(stubLoader()).producer(SMALL)).toEqual({
      kind: "local-transformers-js", library: "@huggingface/transformers", libraryVersion: "4.3.0", onnxRuntime: "onnxruntime-node@1.30.0",
      repo: "BAAI/bge-small-en-v1.5", revision: MODEL_PINS[SMALL].revision, dtype: "fp32",
    });
  });
});

describe("cost accounting through the replay layer", () => {
  it("records tokenizer-exact usage, so neurons are computed from it and are not marked estimated", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-ai-"));
    mkdirSync(join(root, ".eval-cache"), { recursive: true });
    const store = new ReplayStore([], join(root, ".eval-cache", "c.jsonl"), { root });
    const { ai, drainCalls } = makeReplayAi({ store, mode: "record", live: local(stubLoader()) });
    await ai.run(SMALL as never, { text: ["some text"] } as never);
    const [call] = drainCalls();
    expect(call).toMatchObject({ source: "live", kind: "embedding", neuronsEstimated: false });
    expect(call.neurons).toBeCloseTo((2 * NEURON_RATES[SMALL].inputPerMillionTokens) / 1_000_000, 12);
    await ai.run(SMALL as never, { text: ["some text"] } as never); // replayed from the cache: same exact count
    expect(drainCalls()[0]).toMatchObject({ source: "replay", neuronsEstimated: false, neurons: call.neurons });
    const rr = makeReplayAi({ store, mode: "record", live: local(stubLoader()) });
    await rr.ai.run(RERANK as never, { query: "q", contexts: [{ text: "good" }] } as never);
    expect(rr.drainCalls()[0]).toMatchObject({ kind: "other", neuronsEstimated: false, neurons: (7 * NEURON_RATES[RERANK].inputPerMillionTokens) / 1_000_000 });
  });
});

describe("pins", () => {
  it("pin every model to a full 40-hex commit, fp32, and a sha256 for every file the runtime reads", () => {
    for (const [id, pin] of Object.entries(MODEL_PINS)) {
      expect(pin.model).toBe(id);
      expect(pin.revision, id).toMatch(/^[0-9a-f]{40}$/);
      expect(pin.dtype).toBe("fp32");
      expect(pin.dir.endsWith(pin.revision.slice(0, 12)), id).toBe(true);
      expect(Object.keys(pin.files), id).toEqual(expect.arrayContaining(["config.json", "tokenizer.json", "onnx/model.onnx"]));
      for (const h of Object.values(pin.files)) expect(h, id).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(MODEL_PINS["@cf/baai/bge-m3"].files)).toContain("onnx/model.onnx_data");
  });

  it("covers the production model ids the eval prices", () => {
    for (const id of [SMALL, M3, RERANK]) expect(NEURON_RATES[id], id).toBeDefined();
    expect(MODEL_PINS[SMALL].dims).toBe(384);
    expect(MODEL_PINS[M3].dims).toBe(1024);
  });

  it("producer identity changes with any pinned field", () => {
    const a = producerFor(MODEL_PINS[SMALL], "4.3.0", "1.30.0");
    expect(producerFor(MODEL_PINS[M3], "4.3.0", "1.30.0")).not.toEqual(a);
    expect(a.revision).toBe(MODEL_PINS[SMALL].revision);
  });
});

describe("hash verification", () => {
  const sha = (b: string) => createHash("sha256").update(b).digest("hex");
  const pin = (files: Record<string, string>) => ({ ...MODEL_PINS[SMALL], dir: "m", files });
  const fetchOf = (bodies: Record<string, string>) => vi.fn(async (url: string | URL | Request) => {
    const file = String(url).split("/resolve/")[1].split("/").slice(1).join("/");
    return file in bodies ? new Response(bodies[file]) : new Response("nope", { status: 404 });
  });

  it("downloads missing files from the pinned repo and commit, anonymously, and installs them only when the hash matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    const p = pin({ "config.json": sha("cfg"), "onnx/model.onnx": sha("weights") });
    const f = fetchOf({ "config.json": "cfg", "onnx/model.onnx": "weights" });
    await ensureModelFiles(p, dir, f as never);
    expect(readFileSync(join(dir, "m/onnx/model.onnx"), "utf8")).toBe("weights");
    for (const [url, init] of f.mock.calls as unknown as [string, RequestInit | undefined][]) {
      expect(url).toContain(`https://huggingface.co/${p.repo}/resolve/${p.revision}/`);
      expect(JSON.stringify(init ?? {})).not.toMatch(/authorization|token/i);
    }
    const again = fetchOf({});
    await ensureModelFiles(p, dir, again as never); // verified on disk, so no second download
    expect(again).not.toHaveBeenCalled();
  });

  it("refuses a download whose hash differs and leaves nothing behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    await expect(ensureModelFiles(pin({ "config.json": sha("cfg") }), dir, fetchOf({ "config.json": "tampered" }) as never)).rejects.toBeInstanceOf(ModelHashMismatch);
    expect(existsSync(join(dir, "m/config.json"))).toBe(false);
    expect(readdirSync(join(dir, "m"))).toEqual([]);
  });

  it("refuses a file already on disk that no longer matches, without replacing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    mkdirSync(join(dir, "m"), { recursive: true });
    writeFileSync(join(dir, "m/config.json"), "edited");
    const f = fetchOf({ "config.json": "cfg" });
    await expect(ensureModelFiles(pin({ "config.json": sha("cfg") }), dir, f as never)).rejects.toThrow(/delete it to refetch/);
    expect(f).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "m/config.json"), "utf8")).toBe("edited");
  });

  it("fails on a failed download", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    await expect(ensureModelFiles(pin({ "config.json": sha("cfg") }), dir, fetchOf({}) as never)).rejects.toThrow(/failed \(404\)/);
  });
});

describe("no Cloudflare credentials in the eval tooling", () => {
  it("nothing in the eval tooling reads an account id or API token, or calls the Cloudflare API", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|mjs)$/.test(p)) files.push(p); } };
    walk(join(REPO, "test/eval"));
    // Eval entry points use the eval- prefix. Deployment scripts legitimately
    // read Cloudflare account IDs and are outside this local-only tooling.
    const scripts = join(REPO, "scripts");
    for (const name of readdirSync(scripts)) {
      if (/^eval-.*\.(ts|mjs)$/.test(name)) files.push(join(scripts, name));
    }
    const banned = new RegExp(["CLOUDFLARE_API_" + "TOKEN", "CLOUDFLARE_ACCOUNT_" + "ID", "api\\.cloudflare" + "\\.com", "make" + "RestAi", "HF_" + "TOKEN"].join("|"));
    const hits = files.filter(f => !f.endsWith("local-ai.test.ts") && banned.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("the Worker source never imports the local inference stack", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
    walk(join(REPO, "src"));
    expect(files.filter(f => /@huggingface|onnxruntime|test\/eval/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
