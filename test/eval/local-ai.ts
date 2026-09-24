import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { LiveAi } from "./ai-replay";
import type { EmbeddingProducer } from "./types";

/*
 * Local open-weights stand-in for Workers AI. The eval never touches a Cloudflare account: vectors and reranker
 * scores come from the same BGE weights Workers AI serves, run in-process by transformers.js (fp32 ONNX).
 * They are NOT byte-identical to Workers AI output (different runtime, kernels, and possibly export), so every
 * cache row set carries the producer (see EmbeddingProducer) and reports from different producers never compare.
 * Hugging Face downloads are anonymous: no token is read or sent.
 */

export interface ModelPin {
  /** The Workers AI model id this pin stands in for. */
  model: string;
  kind: "embedding" | "reranker";
  repo: string;
  /** Exact commit, never a branch. */
  revision: string;
  dtype: "fp32";
  /** Directory under .eval-cache/models. */
  dir: string;
  /** Truncation length in tokens. */
  maxTokens: number;
  dims?: number;
  /** sha256 of every file the runtime reads, keyed by repo-relative path. */
  files: Readonly<Record<string, string>>;
}

export const MODEL_PINS: Readonly<Record<string, ModelPin>> = {
  "@cf/baai/bge-small-en-v1.5": {
    model: "@cf/baai/bge-small-en-v1.5", kind: "embedding", repo: "BAAI/bge-small-en-v1.5", revision: "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
    dtype: "fp32", dir: "bge-small-en-v1.5-5c38ec7c405e", maxTokens: 512, dims: 384,
    files: {
      "config.json": "094f8e891b932f2000c92cfc663bac4c62069f5d8af5b5278c4306aef3084750",
      "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
      "tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
      "special_tokens_map.json": "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
      "onnx/model.onnx": "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35",
    },
  },
  // Xenova's repo is the transformers.js-ready export of BAAI/bge-m3; its weights blob (model.onnx_data) has the same sha256 as BAAI's own onnx/.
  "@cf/baai/bge-m3": {
    model: "@cf/baai/bge-m3", kind: "embedding", repo: "Xenova/bge-m3", revision: "4de13258303883538bd53b696b452bf8099f0858",
    dtype: "fp32", dir: "bge-m3-4de132583038", maxTokens: 8192, dims: 1024,
    files: {
      "config.json": "734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95",
      "tokenizer.json": "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790",
      "tokenizer_config.json": "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4",
      "special_tokens_map.json": "8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835",
      "onnx/model.onnx": "5d89a0010dd39aa2cfa8b22bb49f06904c5bbf5877135f877da419480f40cde3",
      "onnx/model.onnx_data": "1eebfb28493f67bba03ce0ef64bfdc7fc5a3bd9d7493f818bb1d78cd798416b4",
    },
  },
  "@cf/baai/bge-reranker-base": {
    model: "@cf/baai/bge-reranker-base", kind: "reranker", repo: "BAAI/bge-reranker-base", revision: "2cfc18c9415c912f9d8155881c133215df768a70",
    dtype: "fp32", dir: "bge-reranker-base-2cfc18c9415c", maxTokens: 512,
    files: {
      "config.json": "289adf7ada1eb6b4afa7589a48a032d45a076cf2e46dcdb3b4cabc33be14f708",
      "tokenizer.json": "9eb652ac4e40cc093272bbbe0f55d521cf67570060227109b5cdc20945a4489e",
      "tokenizer_config.json": "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
      "special_tokens_map.json": "d5469a60db23249c7f8945013d78df30b44b6bf686c6bb4740f4223f77b1b535",
      "onnx/model.onnx": "15b9a8c3da82eddf263df571281166e00e9308fe19d077084b642ebfcaf06d2b",
    },
  },
};

export const localModels = (): string[] => Object.keys(MODEL_PINS);

// ---- pure math (unit-tested without a model) ----

export type Pooling = "cls" | "mean";

export interface EncodedBatch {
  /** Row-major [batch, seq, dim] last hidden states. */
  hidden: Float32Array;
  batch: number;
  seq: number;
  dim: number;
  /** attention[b][t] is 1 for a real token and 0 for padding. */
  attention: number[][];
  /** How many inputs the tokenizer cut at the model's limit. Absent on fakes. */
  truncated?: number;
}

export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm > 0 ? v.map(x => x / norm) : v;
}

/** CLS takes token 0; mean averages the real (unmasked) tokens. Either way the row is L2-normalized. */
export function poolBatch(enc: EncodedBatch, pooling: Pooling): Float32Array[] {
  const rows: Float32Array[] = [];
  for (let b = 0; b < enc.batch; b++) {
    const out = new Float32Array(enc.dim);
    const at = (t: number) => (b * enc.seq + t) * enc.dim;
    if (pooling === "cls") {
      out.set(enc.hidden.subarray(at(0), at(0) + enc.dim));
    } else {
      let n = 0;
      for (let t = 0; t < enc.seq; t++) {
        if (!enc.attention[b][t]) continue;
        n++;
        for (let d = 0; d < enc.dim; d++) out[d] += enc.hidden[at(t) + d];
      }
      for (let d = 0; d < enc.dim; d++) out[d] /= Math.max(n, 1);
    }
    rows.push(l2normalize(out));
  }
  return rows;
}

/** Real tokens across the batch: the same count the tokenizer feeds the model, i.e. what a token-metered API would bill. */
export const countTokens = (attention: number[][]): number => attention.reduce((s, row) => s + row.reduce((a, m) => a + (m ? 1 : 0), 0), 0);

// ---- pins: download and hash verification ----

const sha256File = async (path: string): Promise<string> => {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
};

export class ModelHashMismatch extends Error {}

const fileUrl = (pin: ModelPin, file: string) => `https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${file}`;

/**
 * Makes sure every pinned file is present with the pinned sha256. Missing files are downloaded anonymously (no
 * Authorization header) to a temp file, hashed, and only renamed into place when the hash matches. A file already on
 * disk that does not match is an error, never silently replaced: delete it deliberately to refetch.
 */
export async function ensureModelFiles(pin: ModelPin, modelsDir: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const root = join(modelsDir, pin.dir);
  for (const [file, want] of Object.entries(pin.files)) {
    const path = join(root, file);
    if (existsSync(path)) {
      const got = await sha256File(path);
      if (got !== want) throw new ModelHashMismatch(`${path} has sha256 ${got}, pinned ${want} (${pin.repo}@${pin.revision}); delete it to refetch`);
      continue;
    }
    const res = await fetchImpl(fileUrl(pin, file), { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`download of ${fileUrl(pin, file)} failed (${res.status})`);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
      const got = await sha256File(tmp);
      if (got !== want) throw new ModelHashMismatch(`downloaded ${file} has sha256 ${got}, pinned ${want} (${pin.repo}@${pin.revision}); not installed`);
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return root;
}

// ---- runtimes ----

export interface EmbedRuntime { encode(texts: string[], maxTokens: number): Promise<EncodedBatch> }
export interface RerankRuntime { score(query: string, docs: string[], maxTokens: number): Promise<{ logits: number[]; tokens: number }> }
export interface RuntimeLoader {
  embed(pin: ModelPin, dir: string): Promise<EmbedRuntime>;
  rerank(pin: ModelPin, dir: string): Promise<RerankRuntime>;
}

const EVAL_ROOT = process.env.SB_EVAL_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MODELS_DIR = resolve(EVAL_ROOT, ".eval-cache/models");

/** Version of an installed package, read from disk (works from source and from the esbuild bundle). */
function installedVersion(pkg: string): string {
  for (let dir = EVAL_ROOT; ; dir = dirname(dir)) {
    const p = join(dir, "node_modules", pkg, "package.json");
    if (existsSync(p)) return (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version;
    if (dirname(dir) === dir) throw new Error(`${pkg} is not installed; run npm install`);
  }
}

/** transformers.js, imported lazily so nothing loads (or downloads) unless a live call is made. */
export const transformersLoader: RuntimeLoader = {
  async embed(pin, dir) {
    const tf = await import("@huggingface/transformers");
    tf.env.allowRemoteModels = false;
    const tokenizer = await tf.AutoTokenizer.from_pretrained(dir, { local_files_only: true });
    const model = await tf.AutoModel.from_pretrained(dir, { local_files_only: true, dtype: pin.dtype });
    return {
      async encode(texts, maxTokens) {
        const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: maxTokens });
        // An input past the limit is silently cut; count them so a caller can refuse a recording that depends on it.
        const full = tokenizer(texts, { padding: false, truncation: false, return_tensor: false }) as { input_ids: number[][] };
        const truncated = full.input_ids.filter(ids => ids.length > maxTokens).length;
        const out = await model(inputs);
        const hidden = out.last_hidden_state;
        const [batch, seq, dim] = hidden.dims as number[];
        const mask = inputs.attention_mask;
        const attention = Array.from({ length: batch }, (_, b) => Array.from({ length: seq }, (_, t) => Number(mask.data[b * seq + t])));
        return { hidden: hidden.data as Float32Array, batch, seq, dim, attention, truncated };
      },
    };
  },
  async rerank(pin, dir) {
    const tf = await import("@huggingface/transformers");
    tf.env.allowRemoteModels = false;
    const tokenizer = await tf.AutoTokenizer.from_pretrained(dir, { local_files_only: true });
    const model = await tf.AutoModelForSequenceClassification.from_pretrained(dir, { local_files_only: true, dtype: pin.dtype });
    return {
      async score(query, docs, maxTokens) {
        const inputs = tokenizer(docs.map(() => query), { text_pair: docs, padding: true, truncation: true, max_length: maxTokens });
        const { logits } = await model(inputs);
        return { logits: Array.from(logits.data as Float32Array), tokens: countTokens(rows(inputs.attention_mask)) };
      },
    };
  },
};

function rows(mask: { data: ArrayLike<number | bigint>; dims: number[] }): number[][] {
  const [n, seq] = mask.dims;
  return Array.from({ length: n }, (_, b) => Array.from({ length: seq }, (_, t) => Number(mask.data[b * seq + t])));
}

// ---- the provider ----

export interface LocalAi extends LiveAi {
  /** Who produces this model's outputs; recorded beside the cached rows and on every report. */
  producer(model: string): EmbeddingProducer;
  /** Inputs cut at the token limit since this provider was made, per model. Recording contextual vectors must leave it at zero. */
  truncations: Record<string, number>;
}

export function producerFor(pin: ModelPin, libraryVersion: string, runtimeVersion: string): EmbeddingProducer {
  return { kind: "local-transformers-js", library: "@huggingface/transformers", libraryVersion, onnxRuntime: `onnxruntime-node@${runtimeVersion}`, repo: pin.repo, revision: pin.revision, dtype: pin.dtype };
}

interface EmbedInput { text?: string | string[]; pooling?: string; truncate_inputs?: boolean }
interface RerankInput { query?: string; contexts?: { text?: string }[]; top_k?: number }

/**
 * Workers AI semantics, locally. bge-en models take {text, pooling?}: pooling defaults to MEAN (Workers AI's documented
 * default, and what src/lib/ai.ts gets since it sends none); `pooling: "cls"` selects CLS. bge-m3 is always CLS.
 * Vectors are L2-normalized. Input is truncated at the model's token limit. Responses are {shape, data, usage}, where
 * usage.prompt_tokens is the tokenizer-exact count (special tokens included, truncation applied) for cost accounting.
 * The reranker returns {response: [{id, score}]} sorted best first, with the RAW logit as score: Cloudflare's model page
 * (https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/) says the score "can be mapped to a float
 * value in [0,1] by sigmoid function", i.e. the API does not apply it. Parity with the live API is UNVERIFIED: no
 * Cloudflare account may be used here, so this follows the documentation alone. Neuron usage is a projection (local
 * tokenizer counts times published rates), not a billed figure.
 */
export function makeLocalAi(opts: { loader?: RuntimeLoader; modelsDir?: string; fetchImpl?: typeof fetch; verify?: boolean; versions?: { library: string; onnxRuntime: string } } = {}): LocalAi {
  const loader = opts.loader ?? transformersLoader;
  const modelsDir = opts.modelsDir ?? MODELS_DIR;
  const embedders = new Map<string, Promise<EmbedRuntime>>();
  const rerankers = new Map<string, Promise<RerankRuntime>>();
  const truncations: Record<string, number> = {};
  let queue: Promise<unknown> = Promise.resolve(); // one inference at a time: ONNX already uses every core, and m3 is 2GB of weights
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };
  const pinOf = (model: string, kind: ModelPin["kind"]): ModelPin => {
    const pin = MODEL_PINS[model];
    if (!pin || pin.kind !== kind) throw new Error(`no local ${kind} model for ${model}; local models: ${localModels().join(", ")}`);
    return pin;
  };
  const ready = async (pin: ModelPin) => (opts.verify === false ? join(modelsDir, pin.dir) : ensureModelFiles(pin, modelsDir, opts.fetchImpl));
  const memo = <T>(cache: Map<string, Promise<T>>, model: string, make: () => Promise<T>): Promise<T> => {
    let p = cache.get(model);
    if (!p) { p = make(); cache.set(model, p); p.catch(() => cache.delete(model)); }
    return p;
  };

  return {
    truncations,
    producer(model) {
      const pin = MODEL_PINS[model];
      if (!pin) throw new Error(`no local model for ${model}`);
      return producerFor(pin, opts.versions?.library ?? installedVersion("@huggingface/transformers"), opts.versions?.onnxRuntime ?? installedVersion("onnxruntime-node"));
    },
    run(model, input) {
      const pin = MODEL_PINS[model];
      if (!pin) return Promise.reject(new Error(`no local model for ${model}; local models: ${localModels().join(", ")}`));
      if (pin.kind === "embedding") return serial(async () => {
        const { text, pooling } = (input ?? {}) as EmbedInput;
        const texts = typeof text === "string" ? [text] : text;
        if (!Array.isArray(texts) || !texts.length || texts.some(t => typeof t !== "string")) throw new Error(`${model} needs {text: string | string[]}`);
        if (pooling !== undefined && pooling !== "cls" && pooling !== "mean") throw new Error(`${model}: pooling must be "cls" or "mean", got ${String(pooling)}`);
        const p = pinOf(model, "embedding");
        const rt = await memo(embedders, model, async () => loader.embed(p, await ready(p)));
        const mode: Pooling = model === "@cf/baai/bge-m3" ? "cls" : pooling ?? "mean";
        const enc = await rt.encode(texts, p.maxTokens);
        if (enc.truncated) truncations[model] = (truncations[model] ?? 0) + enc.truncated;
        const vectors = poolBatch(enc, mode);
        if (p.dims && enc.dim !== p.dims) throw new Error(`${model} produced ${enc.dim}-d vectors, expected ${p.dims}`);
        const tokens = countTokens(enc.attention);
        return { shape: [vectors.length, enc.dim], data: vectors.map(v => Array.from(v)), usage: { prompt_tokens: tokens, total_tokens: tokens } };
      });
      return serial(async () => {
        const { query, contexts, top_k } = (input ?? {}) as RerankInput;
        if (typeof query !== "string" || !query || !Array.isArray(contexts) || contexts.some(c => typeof c?.text !== "string")) throw new Error(`${model} needs {query, contexts: [{text}]}`);
        const p = pinOf(model, "reranker");
        const rt = await memo(rerankers, model, async () => loader.rerank(p, await ready(p)));
        if (!contexts.length) return { response: [], usage: { prompt_tokens: 0, total_tokens: 0 } };
        const { logits, tokens } = await rt.score(query, contexts.map(c => c.text as string), p.maxTokens);
        const scored = logits.map((l, id) => ({ id, score: l })).sort((a, b) => b.score - a.score || a.id - b.id);
        return { response: typeof top_k === "number" ? scored.slice(0, top_k) : scored, usage: { prompt_tokens: tokens, total_tokens: tokens } };
      });
    },
  };
}
