import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { hashVector } from "./vectors";

export type ReplayMode = "replay" | "record" | "dry";

export class ReplayMissError extends Error {
  constructor(readonly model: string, readonly key: string, preview: string) {
    super(`replay cache miss for ${model} (sha256 ${key}): "${preview}". Record it with: npm run eval:recall -- prepare --variant <name> --corpus <id>`);
  }
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const replayKey = (model: string, input: unknown): string =>
  createHash("sha256").update(model).update("\0").update(stableStringify(input)).digest("hex");

// Neurons per million tokens. Verified 2026-09-23 against
// https://developers.cloudflare.com/workers-ai/platform/pricing/
// An unknown model throws instead of costing 0.
export const NEURON_RATES: Record<string, { inputPerMillionTokens: number; outputPerMillionTokens?: number }> = {
  "@cf/baai/bge-small-en-v1.5": { inputPerMillionTokens: 1841 },
  "@cf/baai/bge-base-en-v1.5": { inputPerMillionTokens: 6058 },
  "@cf/baai/bge-large-en-v1.5": { inputPerMillionTokens: 18582 },
  "@cf/baai/bge-m3": { inputPerMillionTokens: 1075 },
  "@cf/baai/bge-reranker-base": { inputPerMillionTokens: 283 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { inputPerMillionTokens: 24545, outputPerMillionTokens: 77273 },
};

export const EMBEDDING_DIMS: Record<string, number> = {
  "@cf/baai/bge-small-en-v1.5": 384,
  "@cf/baai/bge-base-en-v1.5": 768,
  "@cf/baai/bge-large-en-v1.5": 1024,
  "@cf/baai/bge-m3": 1024,
};

const CJK = /[぀-ヿ㐀-鿿가-힯]/u;

/** Rough token estimate: about 4 characters per token for Latin text, 1 per CJK character. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (CJK.test(ch)) cjk++;
  return Math.ceil((text.length - cjk) / 4 + cjk);
}

export function estimateNeurons(model: string, inputText: string, outputText = ""): number {
  const rate = NEURON_RATES[model];
  if (!rate) throw new Error(`no neuron rate for ${model}: add it to NEURON_RATES (test/eval/ai-replay.ts) before running this variant`);
  return (estimateTokens(inputText) * rate.inputPerMillionTokens + estimateTokens(outputText) * (rate.outputPerMillionTokens ?? 0)) / 1_000_000;
}

type Stored = { f32: string[] } | { text: string } | { json: unknown };

const toBase64 = (row: number[]) => Buffer.from(new Float32Array(row).buffer).toString("base64");
function fromBase64(b64: string): number[] {
  const bytes = Buffer.from(b64, "base64");
  const copy = new ArrayBuffer(bytes.length); // aligned copy: a pooled Buffer's offset may not be 4-byte aligned
  new Uint8Array(copy).set(bytes);
  return Array.from(new Float32Array(copy));
}

/** Append-only JSONL, optionally gzipped for committed read-only layers. */
export class ReplayStore {
  private readonly map = new Map<string, Stored>();
  constructor(readPaths: readonly string[], private readonly writePath?: string) {
    for (const p of readPaths) this.load(p);
    if (writePath) this.load(writePath);
  }
  private load(path: string) {
    if (!existsSync(path)) return;
    const raw = readFileSync(path);
    const text = (path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      const { k, v } = JSON.parse(line) as { k: string; v: Stored };
      this.map.set(k, v);
    }
  }
  /** Keys served since construction; lets a run export exactly the slice it needed. */
  readonly used = new Set<string>();
  get(key: string): Stored | undefined {
    const value = this.map.get(key);
    if (value) this.used.add(key);
    return value;
  }
  /** Writes only the keys this run used to a gzipped JSONL file (the committed core cache). */
  exportUsed(path: string): number {
    const lines = [...this.used].sort().map(k => JSON.stringify({ k, v: this.map.get(k) }));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, gzipSync(`${lines.join("\n")}\n`));
    return lines.length;
  }
  put(key: string, value: Stored): void {
    if (!this.writePath) throw new Error("replay store is read-only");
    mkdirSync(dirname(this.writePath), { recursive: true });
    appendFileSync(this.writePath, `${JSON.stringify({ k: key, v: value })}\n`);
    this.map.set(key, value);
  }
  get size() { return this.map.size; }
}

export interface LiveAi { run(model: string, input: unknown): Promise<unknown> }

/** Workers AI over REST: compute only, no bindings to any production resource. */
export function makeRestAi(opts: { accountId: string; apiToken: string; fetchImpl?: typeof fetch; maxRetries?: number }): LiveAi {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async run(model, input) {
      for (let attempt = 0; ; attempt++) {
        const res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/run/${model}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if ((res.status === 429 || res.status >= 500) && attempt < (opts.maxRetries ?? 5)) {
          await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
          continue;
        }
        const body = await res.json() as { success?: boolean; result?: unknown; errors?: { message: string }[] };
        if (!res.ok || body.success === false) {
          throw new Error(`Workers AI ${model} failed (${res.status}): ${(body.errors ?? []).map(e => e.message).join("; ")}`);
        }
        return body.result;
      }
    },
  };
}

export class NeuronBudget {
  spent = 0;
  constructor(readonly limit: number) {}
  charge(n: number) {
    if (this.spent + n > this.limit) throw new Error(`neuron budget exceeded: ${(this.spent + n).toFixed(1)} > ${this.limit}. Raise --max-neurons deliberately.`);
    this.spent += n;
  }
}

export interface AiCall { model: string; kind: "embedding" | "llm" | "other"; neurons: number; source: "replay" | "live" | "stub" | "dry" }
export interface ReplayAi {
  ai: Ai;
  /** Calls since the last drain; the runner drains once per query. */
  drainCalls(): AiCall[];
  /** Cache misses seen in dry mode, keyed by replay key. */
  misses: Map<string, { model: string; preview: string; neurons: number }>;
}

type AiInput = { text?: string[]; messages?: { content: string }[]; stream?: boolean };
const kindOf = (input: AiInput): AiCall["kind"] => Array.isArray(input.text) ? "embedding" : Array.isArray(input.messages) ? "llm" : "other";
const inputText = (kind: AiCall["kind"], input: AiInput) =>
  kind === "embedding" ? input.text!.join("\n") : kind === "llm" ? input.messages!.map(m => m.content).join("\n") : stableStringify(input);

function sseStream(text: string): ReadableStream {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      if (text) c.enqueue(enc.encode(`data: ${JSON.stringify({ response: text })}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

function respond(input: AiInput, stored: Stored): unknown {
  if ("f32" in stored) return { data: stored.f32.map(fromBase64) };
  if ("text" in stored) return input.stream ? sseStream(stored.text) : { response: stored.text };
  return stored.json;
}

function encode(kind: AiCall["kind"], result: any): Stored {
  if (kind === "embedding") return { f32: (result.data as number[][]).map(toBase64) };
  if (kind === "llm") return { text: String(result?.response ?? result?.choices?.[0]?.message?.content ?? "") };
  return { json: result };
}

export function makeReplayAi(opts: {
  store: ReplayStore;
  mode: ReplayMode;
  live?: LiveAi;
  budget?: NeuronBudget;
  /** Record LLM calls too (query-tag inference); off by default because it spends neurons on non-embedding work. */
  recordLlm?: boolean;
  /** Dry-mode answer for non-embedding, non-LLM calls (a rerank variant supplies its own). */
  dryOther?: (model: string, input: unknown) => unknown;
}): ReplayAi {
  const calls: AiCall[] = [];
  const misses: ReplayAi["misses"] = new Map();
  const run = async (model: string, input: AiInput) => {
    const kind = kindOf(input);
    const key = replayKey(model, input);
    const text = inputText(kind, input);
    const hit = opts.store.get(key);
    if (hit) {
      const out = "text" in hit ? hit.text : "";
      calls.push({ model, kind, neurons: estimateNeurons(model, text, out), source: "replay" });
      return respond(input, hit);
    }
    const preview = text.slice(0, 60).replace(/\s+/g, " ");
    if (kind === "llm" && (opts.mode === "replay" || !opts.recordLlm)) {
      calls.push({ model, kind, neurons: estimateNeurons(model, text), source: "stub" });
      return input.stream ? sseStream("") : { response: "" };
    }
    if (opts.mode === "dry") {
      const neurons = estimateNeurons(model, text);
      misses.set(key, { model, preview, neurons });
      calls.push({ model, kind, neurons, source: "dry" });
      if (kind === "embedding") return { data: [hashVector(text, EMBEDDING_DIMS[model] ?? 384)] };
      if (kind === "llm") return input.stream ? sseStream("") : { response: "" };
      if (opts.dryOther) return opts.dryOther(model, input);
      throw new ReplayMissError(model, key, preview);
    }
    if (opts.mode === "replay" || !opts.live) throw new ReplayMissError(model, key, preview);
    const neurons = estimateNeurons(model, text, kind === "llm" ? "x".repeat(160) : "");
    opts.budget?.charge(neurons);
    const result = await opts.live.run(model, kind === "llm" ? { ...input, stream: false } : input);
    const stored = encode(kind, result);
    opts.store.put(key, stored);
    calls.push({ model, kind, neurons, source: "live" });
    return respond(input, stored);
  };
  return {
    ai: { run } as unknown as Ai,
    drainCalls: () => calls.splice(0),
    misses,
  };
}
