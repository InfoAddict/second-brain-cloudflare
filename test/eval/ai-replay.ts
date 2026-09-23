import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync,
  renameSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { hashVector } from "./vectors";

export type ReplayMode = "replay" | "record" | "dry";

export class ReplayMissError extends Error {
  constructor(readonly model: string, readonly key: string, preview: string) {
    super(`replay cache miss for ${model} (sha256 ${key}): "${preview}". Record it with: npm run eval:recall -- prepare --variant <name> --corpus <id>`);
  }
}

/** Replay inputs must be plain JSON: anything else (Date, Map, ...) has a wire form JSON.stringify would silently collapse. */
export function stableStringify(v: unknown): string {
  return stringify(v, "$", []);
}

function stringify(v: unknown, path: string, ancestors: object[]): string {
  const bad = (what: string): never => {
    throw new TypeError(`replay inputs must be plain JSON values: ${what} at ${path}`);
  };
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : bad(`non-finite number ${v}`);
  if (typeof v !== "object") return bad(typeof v);
  if (ancestors.includes(v)) throw new TypeError(`replay inputs must be plain JSON values: cycle at ${path}`);
  const next = [...ancestors, v];
  if (Array.isArray(v)) return `[${v.map((x, i) => stringify(x, `${path}[${i}]`, next)).join(",")}]`;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return bad(`${v.constructor?.name ?? "non-plain object"}`);
  const o = v as Record<string, unknown>;
  // JSON.stringify drops undefined properties, so the wire body (and key) match the object without them.
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stringify(o[k], `${path}.${k}`, next)}`).join(",")}}`;
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

/**
 * Conservative upper bound on tokens, for budget enforcement: one token per UTF-8 byte.
 * Every token consumes at least one input byte (byte-level BPE) or code point (WordPiece, [UNK]
 * included), so bytes can never under-count, whatever the script. Emoji (4 bytes) and CJK (3 bytes)
 * are covered, at the price of overstating plain Latin text by about 4x.
 */
export const estimateTokens = (text: string): number => Buffer.byteLength(text, "utf8");

export function estimateNeurons(model: string, inputText: string, outputText = ""): number {
  const rate = NEURON_RATES[model];
  if (!rate) throw new Error(`no neuron rate for ${model}: add it to NEURON_RATES (test/eval/ai-replay.ts) before running this variant`);
  return (estimateTokens(inputText) * rate.inputPerMillionTokens + estimateTokens(outputText) * (rate.outputPerMillionTokens ?? 0)) / 1_000_000;
}

/** Provider counts, when the /ai/run result includes usage (LLM responses do; embeddings may not). */
type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
type Stored = ({ f32: string[] } | { text: string } | { json: unknown }) & { usage?: TokenUsage };

const CJK = /[぀-ヿ㐀-鿿가-힯]/u;

/** Typical tokens for reporting when the provider omits usage; never used to reserve a budget. */
function reportedTokens(text: string): number {
  let latin = 0, cjk = 0, emoji = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else if ((ch.codePointAt(0) ?? 0) > 0xffff) emoji += 2;
    else latin++;
  }
  return Math.ceil(latin / 4 + cjk + emoji);
}

function validTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function providerUsage(result: unknown): TokenUsage | undefined {
  if (!result || typeof result !== "object" || !("usage" in result)) return;
  const raw = (result as { usage?: unknown }).usage;
  if (!raw || typeof raw !== "object") return;
  const usage = raw as Record<string, unknown>;
  const out: TokenUsage = {};
  if (validTokens(usage.prompt_tokens)) out.prompt_tokens = usage.prompt_tokens;
  if (validTokens(usage.completion_tokens)) out.completion_tokens = usage.completion_tokens;
  if (validTokens(usage.total_tokens)) out.total_tokens = usage.total_tokens;
  return Object.keys(out).length ? out : undefined;
}

const toBase64 = (row: number[]) => Buffer.from(new Float32Array(row).buffer).toString("base64");
function fromBase64(b64: string): number[] {
  const bytes = Buffer.from(b64, "base64");
  const copy = new ArrayBuffer(bytes.length); // aligned copy: a pooled Buffer's offset may not be 4-byte aligned
  new Uint8Array(copy).set(bytes);
  return Array.from(new Float32Array(copy));
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Working caches live here (gitignored); nothing under it is ever committed. */
const CACHE_DIR = ".eval-cache";
/** The only committed location an export may target: the synthetic core cache (`replay.<model>.jsonl.gz`). */
const COMMITTED_DIR = "test/eval/data/core";
const COMMITTED_FILE = /^replay\..+\.jsonl\.gz$/;
const DEFAULT_LOCK_STALE_MS = 120_000;
const LOCK_POLL_MS = 25;
/** How many stale windows a contender waits on a lock that keeps being renewed before giving up. */
const LOCK_WAIT_WINDOWS = 5;

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** Symlink-resolved location of a path that may not exist yet: realpath of the deepest existing ancestor plus the rest. */
function realTarget(path: string): string {
  const rest: string[] = [];
  for (let cur = resolve(path); ; cur = dirname(cur)) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    try {
      lstatSync(cur);
      throw new Error(`${cur} is a dangling symlink`);
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    rest.push(basename(cur));
  }
}

/** Puts a lock we moved aside back without ever clobbering a lock another contender created meanwhile. */
function restoreLock(aside: string, lock: string): void {
  try {
    linkSync(aside, lock);
    return;
  } catch (e) {
    if (errCode(e) === "EEXIST") return; // another contender already took the slot
  }
  // No hardlinks on this filesystem: exclusive-create a copy instead (never rename, which would overwrite).
  try {
    const fd = openSync(lock, "wx");
    try { writeSync(fd, readFileSync(aside)); } finally { closeSync(fd); }
  } catch { /* slot taken, or aside already gone: nothing safe left to do */ }
}

const isInside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

export interface ReplayStoreOptions {
  /** Repo root that .eval-cache/ and the committed data directory hang off; tests point this at a temp dir. */
  root?: string;
  /** A lockfile older than this is treated as abandoned by a dead process. */
  lockStaleMs?: number;
}

/**
 * Append-only JSONL, optionally gzipped for committed read-only layers. Working files must resolve
 * (symlinks included) inside <root>/.eval-cache; read layers may also come from the committed core directory.
 */
export class ReplayStore {
  private readonly map = new Map<string, Stored>();
  private readonly cacheDir: string;
  private readonly committedDir: string;
  private readonly lockStaleMs: number;
  private readonly inflight = new Map<string, Promise<{ stored: Stored; live: boolean }>>();
  private readonly writeFile?: string;
  /** Bytes of the write file already read into the map (complete lines only). */
  private offset = 0;

  constructor(readPaths: readonly string[], writePath?: string, opts: ReplayStoreOptions = {}) {
    const realRoot = realpathSync(opts.root ?? REPO_ROOT);
    this.cacheDir = join(realRoot, CACHE_DIR);
    this.committedDir = join(realRoot, COMMITTED_DIR);
    this.lockStaleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    const inside = (path: string, dirs: string[]) => {
      const abs = resolve(path);
      if (!dirs.some(d => isInside(realTarget(abs), d))) {
        throw new Error(`replay cache path ${path} must resolve inside ${dirs.join(" or ")}`);
      }
      return abs;
    };
    const reads = readPaths.map(p => inside(p, [this.cacheDir, this.committedDir]));
    if (writePath) this.writeFile = inside(writePath, [this.cacheDir]);
    for (const p of reads) this.load(p, false);
    if (this.writeFile) this.load(this.writeFile, true);
  }

  private apply(path: string, lineNo: number, line: string) {
    try {
      const rec = JSON.parse(line) as { k?: unknown; v?: unknown };
      if (typeof rec.k !== "string" || !rec.v || typeof rec.v !== "object") throw new Error("expected {k: string, v: object}");
      this.map.set(rec.k, rec.v as Stored);
    } catch (e) {
      throw new Error(`${path}:${lineNo}: corrupt replay record (${(e as Error).message})`);
    }
  }

  /** Reads every complete line; returns the bytes consumed. A torn final line is skipped, anything else corrupt throws. */
  private ingest(path: string, buf: Buffer): number {
    const complete = buf.lastIndexOf(10) + 1;
    let pos = 0;
    let lineNo = 0;
    while (pos < complete) {
      const nl = buf.indexOf(10, pos);
      lineNo++;
      const line = buf.toString("utf8", pos, nl);
      if (line) this.apply(path, lineNo, line);
      pos = nl + 1;
    }
    if (complete === buf.length) return complete;
    try {
      this.apply(path, lineNo + 1, buf.toString("utf8", complete));
      return buf.length; // intact record that only lacks its newline
    } catch {
      console.warn(`${path}: ignoring incomplete final record (${buf.length - complete} bytes, likely a torn write)`);
      return complete;
    }
  }

  private load(path: string, writable: boolean) {
    if (!existsSync(path)) return;
    const raw = readFileSync(path);
    const buf = path.endsWith(".gz") ? gunzipSync(raw) : raw;
    const consumed = this.ingest(path, buf);
    if (!writable) return;
    // Repair now so the next append cannot concatenate onto the torn tail.
    if (consumed < buf.length) truncateSync(path, consumed);
    else if (buf.length > 0 && buf[buf.length - 1] !== 10) appendFileSync(path, "\n");
    this.offset = statSync(path).size;
  }

  /** Picks up rows other processes appended to the write file since we last looked. */
  private refresh() {
    const path = this.writeFile;
    if (!path || !existsSync(path)) return;
    const size = statSync(path).size;
    if (size <= this.offset) return;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      const complete = buf.subarray(0, buf.lastIndexOf(10) + 1);
      this.ingest(path, complete);
      this.offset += complete.length;
    } finally {
      closeSync(fd);
    }
  }

  /** Keys served since construction; lets a run export exactly the slice it needed. */
  readonly used = new Set<string>();
  get(key: string): Stored | undefined {
    const value = this.map.get(key);
    if (value) this.used.add(key);
    return value;
  }

  /**
   * Writes only the keys this run used to a gzipped JSONL file, via a temp file and rename so a crash
   * never leaves a half-written cache. Allowed targets: inside .eval-cache, or `replay.*.jsonl.gz`
   * in the committed core data directory (the synthetic core cache).
   */
  exportUsed(path: string): number {
    const abs = resolve(path);
    const real = realTarget(abs);
    const allowed = isInside(real, this.cacheDir) || (isInside(real, this.committedDir) && COMMITTED_FILE.test(basename(real)));
    if (!allowed) {
      throw new Error(`exportUsed may write only inside ${this.cacheDir} or ${join(this.committedDir, "replay.<model>.jsonl.gz")}, not ${path}`);
    }
    const lines = [...this.used].sort().map(k => JSON.stringify({ k, v: this.map.get(k) }));
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, gzipSync(`${lines.join("\n")}\n`));
      renameSync(tmp, abs);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* temp may not exist */ }
      throw e;
    }
    return lines.length;
  }

  put(key: string, value: Stored): void {
    const path = this.writeFile;
    if (!path) throw new Error("replay store is read-only");
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const buf = readFileSync(path);
      if (buf.length > 0 && buf[buf.length - 1] !== 10) truncateSync(path, buf.lastIndexOf(10) + 1); // a crashed writer's torn tail
    }
    appendFileSync(path, `${JSON.stringify({ k: key, v: value })}\n`);
    this.map.set(key, value);
  }

  /**
   * When the lock was last renewed: its `t`, or the file's mtime if `t` is missing or not a number. A time
   * more than one stale window in the future (clock stepped back, skewed mount) counts as 0, i.e. stale,
   * so it cannot block every run until the clock catches up.
   */
  private lockTime(lock: string): number {
    const bounded = (ts: number) => (ts > Date.now() + this.lockStaleMs ? 0 : ts);
    try {
      const t = (JSON.parse(readFileSync(lock, "utf8")) as { t?: unknown }).t;
      if (typeof t === "number" && Number.isFinite(t)) return bounded(t);
    } catch (e) {
      if (errCode(e) === "ENOENT") throw e;
    }
    return bounded(statSync(lock).mtimeMs); // unreadable, half-written, or malformed lock: age on disk
  }

  /** Stale-lock takeover: move the lock aside atomically, so only one contender wins, then confirm it really was stale. */
  private breakIfStale(lock: string): boolean {
    try {
      if (Date.now() - this.lockTime(lock) <= this.lockStaleMs) return false;
    } catch (e) {
      if (errCode(e) === "ENOENT") return true;
      throw e;
    }
    const aside = `${lock}.${randomBytes(4).toString("hex")}.stale`;
    try {
      renameSync(lock, aside);
    } catch (e) {
      if (errCode(e) === "ENOENT") return true;
      throw e;
    }
    try {
      if (Date.now() - this.lockTime(aside) > this.lockStaleMs) return true;
      restoreLock(aside, lock); // we moved a fresh lock: put it back
      return false;
    } finally {
      try { unlinkSync(aside); } catch { /* already gone */ }
    }
  }

  /**
   * Cross-process advisory lock: exclusive-create lockfile next to the write file, one per key. It is a
   * lease: the holder renews the timestamp every third of the stale window while `fn` runs, so a slow
   * live call is never mistaken for a dead process. `fn` gets a fence that re-reads the lock and says
   * whether this holder's token is still on it; check it right before writing. The fence is advisory: a
   * sub-50µs window between check and append, after a stall longer than the stale window, can yield one
   * duplicate line for a key (last write wins on load).
   */
  private async withLock<T>(key: string, fn: (stillOwner: () => boolean) => Promise<T>): Promise<T> {
    const lock = `${this.writeFile}.${key}.lock`;
    const token = randomBytes(8).toString("hex");
    const body = () => JSON.stringify({ pid: process.pid, t: Date.now(), token });
    const stillOwner = () => {
      try { return (JSON.parse(readFileSync(lock, "utf8")) as { token?: string }).token === token; } catch { return false; }
    };
    mkdirSync(dirname(lock), { recursive: true }); // clean checkout: the contained .eval-cache/ may not exist yet
    const giveUpAt = Date.now() + LOCK_WAIT_WINDOWS * this.lockStaleMs;
    for (;;) {
      try {
        const fd = openSync(lock, "wx");
        try { writeSync(fd, body()); } finally { closeSync(fd); }
        break;
      } catch (e) {
        if (errCode(e) !== "EEXIST") throw e;
        if (Date.now() > giveUpAt) {
          throw new Error(`timed out after ${LOCK_WAIT_WINDOWS * this.lockStaleMs}ms waiting for replay lock ${lock}, which is still being renewed. If no other eval run is active, delete it and rerun`);
        }
        if (!this.breakIfStale(lock)) await sleep(LOCK_POLL_MS);
      }
    }
    const renew = setInterval(() => {
      try { if (stillOwner()) writeFileSync(lock, body()); } catch { /* the fence catches a lost lock */ }
    }, Math.max(5, this.lockStaleMs / 3));
    renew.unref();
    try {
      return await fn(stillOwner);
    } finally {
      clearInterval(renew);
      if (stillOwner()) try { unlinkSync(lock); } catch { /* already gone */ } // never remove a lock a takeover replaced
    }
  }

  /**
   * Makes `produce` run at most once per key: concurrent callers in this process share the one call, and
   * across processes the lockfile lease serializes contenders, with a cache recheck after acquiring it.
   * `live` is true only for the caller whose `produce` ran. If the lease was lost during `produce`, nothing
   * is appended: the winner's row is returned, waiting up to one stale window for it to land, or this throws if none does. `what` names the
   * request in that error.
   */
  async fill(key: string, produce: () => Promise<Stored>, what = "request"): Promise<{ stored: Stored; live: boolean }> {
    const running = this.inflight.get(key);
    if (running) return { stored: (await running).stored, live: false };
    const flight = this.withLock(key, async stillOwner => {
      this.refresh();
      const cached = this.get(key);
      if (cached) return { stored: cached, live: false };
      const stored = await produce();
      if (!stillOwner()) {
        for (const deadline = Date.now() + this.lockStaleMs; ; await sleep(LOCK_POLL_MS)) {
          this.refresh();
          const winner = this.get(key);
          if (winner) return { stored: winner, live: false };
          if (Date.now() >= deadline) break;
        }
        throw new Error(`replay lock for ${what} (sha256 ${key}) was taken over during a live call and no result was recorded in ${this.writeFile}. Rerun to retry: npm run eval:recall -- prepare --variant <name> --corpus <id>`);
      }
      this.put(key, stored);
      return { stored, live: true };
    });
    this.inflight.set(key, flight);
    try {
      return await flight;
    } finally {
      this.inflight.delete(key);
    }
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
  /** Returns a reservation that was never spent (the live call failed). */
  refund(n: number) { this.spent = Math.max(0, this.spent - n); }
  /** Replaces a reservation with the actual spend; may end above the limit, since the money is already gone. */
  settle(reserved: number, actual: number) { this.spent = Math.max(0, this.spent - reserved + actual); }
}

/** Output tokens reserved against the budget before a live LLM call, unless the caller sets max_tokens or maxOutputTokens. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/** Worst-case cost to reserve before a live call: the input plus a full-length output. */
function reserveNeurons(model: string, inputText: string, outputTokens: number): number {
  const rate = NEURON_RATES[model];
  if (!rate) return estimateNeurons(model, inputText); // throws the standard unknown-model error
  return (estimateTokens(inputText) * rate.inputPerMillionTokens + outputTokens * (rate.outputPerMillionTokens ?? 0)) / 1_000_000;
}

type AiKind = "embedding" | "llm" | "other";

/** Billed-token report. A cache without usage remains replayable, with its estimate labeled. */
function reportedNeurons(model: string, kind: AiKind, inputText: string, stored?: Stored): { neurons: number; estimated: boolean } {
  const rate = NEURON_RATES[model];
  if (!rate) throw new Error(`no neuron rate for ${model}: add it to NEURON_RATES (test/eval/ai-replay.ts) before running this variant`);
  const usage = stored?.usage;
  const prompt = usage?.prompt_tokens ?? (kind === "llm" ? undefined : usage?.total_tokens);
  const completion = kind === "llm"
    ? usage?.completion_tokens ?? (prompt !== undefined && usage?.total_tokens !== undefined && usage.total_tokens >= prompt
      ? usage.total_tokens - prompt : undefined)
    : 0;
  if (prompt !== undefined && completion !== undefined) {
    return { neurons: (prompt * rate.inputPerMillionTokens + completion * (rate.outputPerMillionTokens ?? 0)) / 1_000_000, estimated: false };
  }
  const output = stored && "text" in stored ? stored.text : "";
  return {
    neurons: (reportedTokens(inputText) * rate.inputPerMillionTokens + reportedTokens(output) * (rate.outputPerMillionTokens ?? 0)) / 1_000_000,
    estimated: true,
  };
}

export interface AiCall {
  model: string;
  kind: AiKind;
  neurons: number;
  /** True when the provider omitted complete usage; the reported cost is an approximation. */
  neuronsEstimated: boolean;
  source: "replay" | "live" | "stub" | "dry";
}
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
  const usage = providerUsage(result);
  if (kind === "embedding") return { f32: (result.data as number[][]).map(toBase64), ...(usage && { usage }) };
  if (kind === "llm") return { text: String(result?.response ?? result?.choices?.[0]?.message?.content ?? ""), ...(usage && { usage }) };
  return { json: result, ...(usage && { usage }) };
}

export function makeReplayAi(opts: {
  store: ReplayStore;
  mode: ReplayMode;
  live?: LiveAi;
  budget?: NeuronBudget;
  /** Record LLM calls too (query-tag inference); off by default because it spends neurons on non-embedding work. */
  recordLlm?: boolean;
  /** Output tokens to reserve against the budget before a live LLM call (reporting always prices the actual output). */
  maxOutputTokens?: number;
  /** Dry-mode answer for non-embedding, non-LLM calls (a rerank variant supplies its own). */
  dryOther?: (model: string, input: unknown) => unknown;
}): ReplayAi {
  const calls: AiCall[] = [];
  const misses: ReplayAi["misses"] = new Map();
  const run = async (model: string, input: AiInput) => {
    const kind = kindOf(input);
    const key = replayKey(model, input);
    const text = inputText(kind, input);
    const price = (stored?: Stored) => reportedNeurons(model, kind, text, stored);
    const hit = opts.store.get(key);
    if (hit) {
      const cost = price(hit);
      calls.push({ model, kind, neurons: cost.neurons, neuronsEstimated: cost.estimated, source: "replay" });
      return respond(input, hit);
    }
    const preview = text.slice(0, 60).replace(/\s+/g, " ");
    if (kind === "llm" && (opts.mode === "replay" || !opts.recordLlm)) {
      const cost = price();
      calls.push({ model, kind, neurons: cost.neurons, neuronsEstimated: true, source: "stub" });
      return input.stream ? sseStream("") : { response: "" };
    }
    if (opts.mode === "dry") {
      const neurons = estimateNeurons(model, text);
      misses.set(key, { model, preview, neurons });
      const cost = price();
      calls.push({ model, kind, neurons: cost.neurons, neuronsEstimated: true, source: "dry" });
      if (kind === "embedding") return { data: [hashVector(text, EMBEDDING_DIMS[model] ?? 384)] };
      if (kind === "llm") return input.stream ? sseStream("") : { response: "" };
      if (opts.dryOther) return opts.dryOther(model, input);
      throw new ReplayMissError(model, key, preview);
    }
    if (opts.mode === "replay" || !opts.live) throw new ReplayMissError(model, key, preview);
    const live = opts.live;
    const { stored, live: ranLive } = await opts.store.fill(key, async () => {
      const maxOut = typeof (input as { max_tokens?: unknown }).max_tokens === "number"
        ? (input as { max_tokens: number }).max_tokens : opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const reserved = reserveNeurons(model, text, kind === "llm" ? maxOut : 0);
      opts.budget?.charge(reserved);
      let fresh: Stored;
      try {
        fresh = encode(kind, await live.run(model, kind === "llm" ? { ...input, stream: false } : input));
      } catch (e) {
        opts.budget?.refund(reserved);
        throw e;
      }
      opts.budget?.settle(reserved, price(fresh).neurons);
      return fresh;
    }, `${model} "${preview}"`);
    const cost = price(stored);
    calls.push({ model, kind, neurons: cost.neurons, neuronsEstimated: cost.estimated, source: ranLive ? "live" : "replay" });
    return respond(input, stored);
  };
  return {
    ai: { run } as unknown as Ai,
    drainCalls: () => calls.splice(0),
    misses,
  };
}
