/**
 * UX-I: builds a real Worker `env` that touches no Cloudflare account, ever.
 *
 * D1 and KV are real: `getPlatformProxy` runs wrangler's own local D1 (SQLite) and KV against a
 * persistent state directory, the same mechanism test/eval/d1.ts uses for the eval harness's
 * workerd backend, pointed at a config that declares ONLY d1_databases and kv_namespaces (no
 * `ai` or `vectorize` binding), so nothing here ever asks wrangler to resolve a Workers AI or
 * Vectorize binding, which is what would require a login.
 *
 * AI and Vectorize are local stands-ins:
 *   - embedding calls run for real, in-process, through test/eval/local-ai.ts's transformers.js
 *     runtime (the same BGE weights Workers AI serves) — deterministic, and meaningful similarity
 *     for a walkthrough's recall/search to actually show.
 *   - chat-completion-style calls (classify, merge decisions, digest synthesis) return fixed,
 *     deterministic canned replies. A real local LLM is not part of this: the walkthroughs are
 *     testing dashboard and chat UI behavior, not model quality.
 *   - Vectorize is an in-memory cosine-similarity index over those same embeddings, persisted to
 *     a JSON file beside the D1 state so a reseeded brain's vectors survive a server restart.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeLocalAi } from "../../test/eval/local-ai";

export const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
export const STATE_ROOT = join(ROOT, ".ux-harness", "state");

function compatibilityDate(): string {
  const found = /"compatibility_date"\s*:\s*"([^"]+)"/.exec(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  if (!found) throw new Error("wrangler.jsonc has no compatibility_date");
  return found[1];
}

// ---- local Vectorize: real cosine similarity, zero network ----

interface StoredVector { id: string; values: number[]; metadata?: Record<string, unknown>; namespace?: string }

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** A real, deterministic Vectorize double: cosine search over vectors this same process embedded,
 * persisted to one JSON file so a dev server restart does not silently lose the index. */
function makeLocalVectorize(persistPath: string): VectorizeIndex {
  const store = new Map<string, StoredVector>();
  if (existsSync(persistPath)) {
    try { for (const v of JSON.parse(readFileSync(persistPath, "utf8")) as StoredVector[]) store.set(v.id, v); }
    catch (e) { console.error(`ux-harness: could not read ${persistPath}, starting empty:`, e); }
  }
  let dirty = false;
  const flush = () => {
    if (!dirty) return;
    mkdirSync(join(persistPath, ".."), { recursive: true });
    writeFileSync(persistPath, JSON.stringify([...store.values()]));
    dirty = false;
  };
  const put = (vs: { id: string; values: number[]; metadata?: Record<string, unknown>; namespace?: string }[]) => {
    for (const v of vs) store.set(v.id, v);
    dirty = true; flush();
    return { mutationId: `local-${Date.now()}` };
  };
  return {
    async insert(vs: any[]) { return put(vs); },
    async upsert(vs: any[]) { return put(vs); },
    async deleteByIds(ids: string[]) {
      for (const id of ids) store.delete(id);
      dirty = true; flush();
      return { mutationId: `local-${Date.now()}` };
    },
    async getByIds(ids: string[]) { return ids.map((id) => store.get(id)).filter((v): v is StoredVector => !!v); },
    async describe() { return { dimensions: 384, vectorsCount: store.size }; },
    async query(vector: number[], opts: { topK?: number; filter?: Record<string, unknown>; returnMetadata?: boolean } = {}) {
      const topK = opts.topK ?? 5;
      const matches = [...store.values()]
        .filter((v) => matchesFilter(v, opts.filter))
        .map((v) => ({ id: v.id, score: cosine(vector, v.values), metadata: opts.returnMetadata ? v.metadata : undefined }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return { matches, count: matches.length };
    },
  } as unknown as VectorizeIndex;
}

/**
 * Cloudflare's Vectorize filter is a small Mongo-like subset. The Worker emits exactly two shapes
 * (grep confirms it, src/vectorize/scope.ts is the only place a filter is ever built): bare
 * equality (an implicit $eq) and `{ workspace_id: { $in: [...] } }` (workspaceFilter /
 * singleWorkspaceFilter, every scoped duplicate/contradiction/recall query). This covers exactly
 * those, not the whole documented operator language.
 *
 * `$in` on a vector whose metadata is missing the field: graph/pass.ts's own comment calls this
 * "not determinable... there is no local Vectorize to observe it against" and deliberately avoids
 * depending on either answer. This mock takes the same "unfavorable" reading that comment already
 * assumes when reasoning about correctness elsewhere: a missing field matches nothing, the same as
 * `[].includes` on an absent value -- there is no stored scalar for `$in` to check membership of.
 */
function matchesFilter(v: StoredVector, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  for (const [key, want] of Object.entries(filter)) {
    const have = (v.metadata ?? {})[key];
    if (typeof want === "object" && want !== null) {
      const ops = want as Record<string, unknown>;
      if ("$eq" in ops && have !== ops.$eq) return false;
      if ("$in" in ops && !(Array.isArray(ops.$in) && have !== undefined && (ops.$in as unknown[]).includes(have))) return false;
    } else if (have !== want) return false;
  }
  return true;
}

// ---- local AI: real embeddings, canned chat completions ----

function sse(text: string): ReadableStream {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: text })}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

interface CapturePromptCandidate { id: string; text: string }

/** Pulls the new memory's text and each offered candidate's id/text out of
 * src/capture/duplicate.ts's own prompt shape (both the "choose one action" and the plain
 * contradiction-check prompts build `existingList` from `[${i+1}] ID: ${r.id}\n${r.content}`
 * blocks, joined by a blank line, right after a `New memory: "${content}"` line). */
function parseCapturePrompt(prompt: string): { newText: string; candidates: CapturePromptCandidate[] } | null {
  const newMatch = /New memory: "([\s\S]*?)"\n\n/.exec(prompt);
  if (!newMatch) return null;
  const candidates: CapturePromptCandidate[] = [];
  const re = /\[\d+\] ID: (\S+)\n([\s\S]*?)(?=\n\n\[\d+\] ID:|\n\nChoose exactly one action|\n\nA contradiction means|$)/g;
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) candidates.push({ id: m[1], text: m[2].trim() });
  return { newText: newMatch[1], candidates };
}

/**
 * A simple, general contradiction heuristic, not tuned to any one test string: two memories that
 * share a leading run of at least 3 words and then diverge -- "I live in Austin" / "I live in
 * Denver" -- are a contradiction, the same canonical shape this codebase's own comments already
 * use as the illustrative case (src/graph/pass.ts, src/capture/duplicate.ts's own prompt text).
 * One memory that is simply a prefix or superset of the other (no divergence) is an elaboration,
 * not a contradiction -- the prompt's own instruction, honored here by requiring both texts to
 * still have a differing word at the point the shared run ends.
 */
function findContradiction(newText: string, candidates: readonly CapturePromptCandidate[]): CapturePromptCandidate | null {
  const words = (s: string) => s.toLowerCase().replace(/[.,!?]/g, "").split(/\s+/).filter(Boolean);
  const newWords = words(newText);
  let best: { candidate: CapturePromptCandidate; prefixLen: number } | null = null;
  for (const candidate of candidates) {
    const candWords = words(candidate.text);
    let prefixLen = 0;
    while (prefixLen < newWords.length && prefixLen < candWords.length && newWords[prefixLen] === candWords[prefixLen]) prefixLen++;
    const diverges = prefixLen < newWords.length && prefixLen < candWords.length;
    if (diverges && prefixLen >= 3 && (!best || prefixLen > best.prefixLen)) best = { candidate, prefixLen };
  }
  return best?.candidate ?? null;
}

/** Deterministic, rule-based stand-in for every non-embedding model call this codebase makes
 * (classify, contradiction/merge decisions, digest synthesis). No network, no randomness. */
function cannedChatCompletion(prompt: string): ReadableStream {
  if (prompt.includes("Choose exactly one action")) {
    const parsed = parseCapturePrompt(prompt);
    const hit = parsed && findContradiction(parsed.newText, parsed.candidates);
    return hit
      ? sse(JSON.stringify({ action: "contradiction", conflicting_id: hit.id, reason: "contradicts an existing memory" }))
      : sse('{"action":"keep_both"}');
  }
  if (prompt.includes("checking if a new memory contradicts")) {
    const parsed = parseCapturePrompt(prompt);
    const hit = parsed && findContradiction(parsed.newText, parsed.candidates);
    return hit
      ? sse(JSON.stringify({ contradicts: true, conflicting_id: hit.id, reason: "contradicts an existing memory" }))
      : sse('{"contradicts": false}');
  }
  if (prompt.includes("Classify this memory")) return sse('{"kind":"note","status":"draft"}');
  // Digest synthesis and anything else: a short, clearly-labeled placeholder paragraph, never empty.
  return sse("(ux-harness local stub: no real model ran for this summary)");
}

function makeLocalAiBinding(): Ai {
  const local = makeLocalAi();
  return {
    async run(model: string, opts: any) {
      if (model.startsWith("@cf/baai/bge")) return local.run(model, opts);
      const prompt: string = (opts?.messages ?? []).map((m: { content: string }) => m.content).join("\n");
      return cannedChatCompletion(prompt);
    },
  } as unknown as Ai;
}

// ---- putting it together ----

export interface LocalEnvHandle {
  env: import("../../src/env").Env;
  close(): Promise<void>;
}

/** One brain = one on-disk state directory under .ux-harness/state/<name>/ (D1 + KV + the vector
 * index), reused across restarts. Pass a fresh `name` to start clean. */
export async function openLocalBrain(name: string): Promise<LocalEnvHandle> {
  const dir = join(STATE_ROOT, name);
  mkdirSync(dir, { recursive: true });
  // wrangler's "name" is alphanumeric-and-dashes only; the brain's own name (e.g. "3.7-solo") is
  // free-form, so it is sanitized here rather than restricted at every call site.
  const safeName = `sb-ux-${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  const configPath = join(dir, "wrangler.jsonc");
  writeFileSync(configPath, JSON.stringify({
    name: safeName,
    compatibility_date: compatibilityDate(),
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [{ binding: "DB", database_name: safeName, database_id: "local-only" }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: "local-only" }],
  }));
  const { getPlatformProxy } = await import("wrangler");
  // remoteBindings: false makes "never a remote binding" structural, not a habit — see test/eval/d1.ts,
  // the same guarantee this project already relies on for the eval harness's workerd backend.
  const proxy = await getPlatformProxy<{ DB: D1Database; OAUTH_KV: KVNamespace }>({
    configPath, persist: { path: join(dir, "persist") }, remoteBindings: false,
  });
  const env = {
    DB: proxy.env.DB,
    OAUTH_KV: proxy.env.OAUTH_KV,
    AI: makeLocalAiBinding(),
    VECTORIZE: makeLocalVectorize(join(dir, "vectorize.json")),
    VECTORIZE_GRACE_MS: "300000",
    AUTH_TOKEN: "ux-harness-local-token",
  } as unknown as import("../../src/env").Env;
  return { env, close: () => proxy.dispose() };
}

/** Deletes a brain's on-disk state so the next openLocalBrain(name) starts genuinely empty. */
export function resetLocalBrain(name: string): void {
  const dir = join(STATE_ROOT, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
