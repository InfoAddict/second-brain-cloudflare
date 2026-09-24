import { RERANK_AMBIGUITY_MARGIN, RERANK_PROBE_TIMEOUT_MS, RERANK_BLEND_WEIGHT, RERANK_EXCERPT_CHARS, RERANK_MAX_CANDIDATES, RERANK_MAX_DIRECT, RERANK_MODEL, RERANK_NOT_READY_TTL_S, RERANK_QUERY_MAX_CHARS, RERANK_READY_CACHE_MS, RERANK_READY_KV_KEY, RERANK_READY_TTL_S, RERANK_TIMEOUT_MS } from "../constants";
import type { RerankMode } from "../config";
import type { Env } from "../env";
import type { VectorizeMatch } from "./math";
import { queryRelevantWindow } from "./snippet";
import type { RerankRoute, RerankTuning } from "./types";

/** Workers AI's documented bge-reranker-base output: `id` indexes the submitted contexts, `score` is a raw logit. */
export type RerankerResponse = { response: { id: number; score: number }[] };

/** Scores by submitted-context index; throws on anything but a complete, finite, duplicate-free answer. */
export function validateRerankerResponse(raw: unknown, count: number): number[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as RerankerResponse).response)) {
    throw new Error("Invalid reranker response");
  }
  const rows = (raw as RerankerResponse).response;
  if (rows.length !== count) throw new Error("Incomplete reranker response");
  const scores = Array<number>(count);
  const seen = new Set<number>();
  for (const row of rows) {
    if (!row || !Number.isInteger(row.id) || row.id < 0 || row.id >= count
      || typeof row.score !== "number" || !Number.isFinite(row.score) || seen.has(row.id)) {
      throw new Error("Invalid reranker score");
    }
    seen.add(row.id);
    scores[row.id] = row.score;
  }
  return scores;
}

const parentOf = (m: VectorizeMatch): string => ((m.metadata as { parentId?: string } | undefined)?.parentId ?? m.id) as string;

/**
 * A token that names one thing exactly: a digit, `#` or `_` anywhere, or a dot between alphanumerics (v1.9, a.b).
 * Sentence punctuation is not part of the token ("cells." is a word) and a hyphen between plain words
 * ("tissue-resident") is prose, so a natural-language question is never mistaken for an identifier lookup.
 */
export function lookupShaped(token: string): boolean {
  const t = token.replace(/[.,;:!?)\]"']+$/u, "");
  return /[\d#_]/.test(t) || /[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(t);
}

/**
 * Cheap, AI-free routing. `on` reranks anything with at least three parents; `auto` also needs the top two
 * heuristic scores within the ambiguity margin. An identifier-shaped query token (#149, v1.9, a-b) is a lexical
 * lookup the keyword arm already answers, so it never pays for a model call.
 */
export function shouldRerank(mode: RerankMode, scores: readonly number[], queryTokens: readonly string[]): Exclude<RerankRoute, "applied" | "error" | "timeout" | "not-ready"> {
  if (mode === "off") return "off";
  if (scores.length < 3) return "too-few";
  if (queryTokens.some(lookupShaped)) return "exact-id";
  if (mode === "on") return "attempted";
  const leader = scores[0];
  return leader > 0 && (leader - scores[1]) / leader <= RERANK_AMBIGUITY_MARGIN ? "attempted" : "clear-leader";
}

/** Percentile per parent, 1 = best submitted, 0 = worst; ties keep submission (baseline) order; all-equal scores are neutral. */
export function percentilesFromScores(parentIds: readonly string[], scores: readonly number[]): Map<string, number> {
  const n = parentIds.length;
  const out = new Map<string, number>();
  if (scores.every(s => s === scores[0])) {
    parentIds.forEach(id => out.set(id, 0.5));
    return out;
  }
  const order = parentIds.map((id, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  order.forEach((idx, rank) => out.set(parentIds[idx], n > 1 ? 1 - rank / (n - 1) : 0.5));
  return out;
}

/** Scales each scored parent's heuristic score by 1 + weight * (2p - 1); unscored parents keep theirs. */
export function blendRerankerScores<T extends VectorizeMatch>(ranked: readonly T[], percentiles: ReadonlyMap<string, number>, weight = RERANK_BLEND_WEIGHT): T[] {
  return ranked.map(match => {
    const p = percentiles.get(parentOf(match));
    return p === undefined ? { ...match } : { ...match, score: match.score * (1 + weight * (2 * p - 1)) };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export interface RerankCandidate { parentId: string; text: string }

/**
 * Up to RERANK_MAX_DIRECT direct parents (heuristic order), then extra graph-root parents up to RERANK_MAX_CANDIDATES.
 * Ids only: the passage text comes from a scoped D1 read, never from Vectorize or keyword metadata.
 */
export function selectRerankIds(direct: readonly VectorizeMatch[], root: readonly VectorizeMatch[], max = RERANK_MAX_CANDIDATES): string[] {
  const ids = new Set<string>();
  const directCap = max - (RERANK_MAX_CANDIDATES - RERANK_MAX_DIRECT);
  for (const m of direct) { if (ids.size >= directCap) break; ids.add(parentOf(m)); }
  for (const m of root) { if (ids.size >= max) break; ids.add(parentOf(m)); }
  return [...ids];
}

class RerankTimeout extends Error {}

const TIMED_OUT = Symbol("reranker timed out");

/**
 * One nonstreaming model call raced against a timer. The guard promise is always settled and the timer always
 * cleared, so nothing is left pending (the eval tracks per-query async work, and a promise that never resolves
 * would hold a query open until garbage collection); a late rejection from the model call is absorbed.
 */
export async function scoreRerankCandidates(query: string, candidates: readonly RerankCandidate[], env: Env, timeoutMs = RERANK_TIMEOUT_MS): Promise<number[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release!: (v: symbol) => void;
  const guard = new Promise<symbol>(resolve => { release = resolve; timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); });
  const call = (env.AI as unknown as { run(model: string, input: unknown): Promise<unknown> })
    .run(RERANK_MODEL, { query: query.slice(0, RERANK_QUERY_MAX_CHARS), contexts: candidates.map(c => ({ text: c.text })), top_k: candidates.length });
  call.catch(() => undefined);
  try {
    const raw = await Promise.race([call, guard]);
    if (raw === TIMED_OUT) throw new RerankTimeout("reranker timed out");
    return validateRerankerResponse(raw, candidates.length);
  } finally {
    clearTimeout(timer);
    release(Symbol("done"));
  }
}

// Readiness latch, cached in both directions like ftsReady; a KV failure reads not-ready and is not cached.
let readyCache: { ready: boolean | null; at: number } | null = null;
export function resetRerankReadyMemo(): void { readyCache = null; }

/** true = probe passed, false = probe failed, null = never probed. */
export async function rerankReadiness(env: Env): Promise<boolean | null> {
  const now = Date.now();
  if (readyCache && now - readyCache.at < RERANK_READY_CACHE_MS) return readyCache.ready;
  try {
    const raw = await env.OAUTH_KV.get(RERANK_READY_KV_KEY);
    const ready = raw === "1" ? true : raw === "0" ? false : null;
    readyCache = { ready, at: now };
    return ready;
  } catch (e) {
    console.error("Reranker ready-flag read failed (skipping the reranker):", e);
    return false;
  }
}

// A known relevant passage must outrank two unrelated ones by a clear margin, or the model is not doing its job.
const PROBE = {
  query: "How do I reset my forgotten password?",
  contexts: [
    { text: "The weather forecast for Tuesday is sunny with light winds and a high of 22 degrees." },
    { text: "To reset a forgotten password, open the account settings page and choose the reset password link; a message with a new sign-in link is then emailed to you." },
    { text: "Quarterly revenue grew by four percent, driven mainly by renewals in the enterprise segment." },
  ],
  relevant: 1,
  margin: 2,
};

export type ProbeResult = { ok: true; margin: number } | { ok: false; reason: string };

/**
 * The model contract probe. One call with a fixed, non-private request: the answer must validate against the
 * documented shape and the relevant passage must lead the others by PROBE.margin logits. Writes the readiness latch
 * either way ("1" for a week, "0" for six hours) so recall never runs an unverified model. Never throws.
 */
export async function probeReranker(env: Env): Promise<ProbeResult> {
  let result: ProbeResult;
  try {
    const scores = await scoreRerankCandidates(PROBE.query, PROBE.contexts.map((c, i) => ({ parentId: String(i), text: c.text })), env, RERANK_PROBE_TIMEOUT_MS);
    const others = scores.filter((_, i) => i !== PROBE.relevant);
    const margin = scores[PROBE.relevant] - Math.max(...others);
    result = margin >= PROBE.margin ? { ok: true, margin } : { ok: false, reason: "the relevant passage did not clearly outrank the unrelated ones" };
  } catch (e) {
    result = { ok: false, reason: e instanceof Error ? e.message : "probe failed" };
  }
  try {
    await env.OAUTH_KV.put(RERANK_READY_KV_KEY, result.ok ? "1" : "0", { expirationTtl: result.ok ? RERANK_READY_TTL_S : RERANK_NOT_READY_TTL_S });
    readyCache = null;
  } catch (e) {
    console.error("Reranker ready latch write failed (non-fatal):", e);
  }
  if (!result.ok) console.error(`Reranker probe failed (recall stays on the heuristic order): ${result.reason}`);
  return result;
}

export interface RerankStepInput {
  mode: RerankMode;
  /** Eval-only: skips the readiness latch (the local fixture has no probe); no route sets it. */
  forced: boolean;
  env: Env;
  ctx: ExecutionContext;
  query: string;
  queryTokens: readonly string[];
  evidenceTokens: readonly string[];
  direct: readonly VectorizeMatch[];
  root: readonly VectorizeMatch[];
  /** Eval-only overrides (RecallVariantFlags.rerankTuning); production passes none. */
  tuning?: RerankTuning;
  /** Scoped D1 passage text for ids not already in hand; the caller applies the tenant clause. */
  loadContent(ids: string[]): Promise<Map<string, string>>;
}

export interface RerankStepResult { route: RerankRoute; percentiles?: Map<string, number>; ms?: number }

/** Decides, scores once, and returns parent percentiles; any failure returns a route and no percentiles, leaving the baseline order. */
export async function rerankStep(o: RerankStepInput): Promise<RerankStepResult> {
  const seen = new Set<string>();
  const directScores = o.direct.filter(m => !seen.has(parentOf(m)) && seen.add(parentOf(m))).map(m => m.score);
  const verdict = shouldRerank(o.mode, directScores, o.queryTokens);
  if (verdict !== "attempted") return { route: verdict };
  if (!o.forced) {
    const ready = await rerankReadiness(o.env);
    if (ready !== true) {
      // Never probed: prove the model once, off the hot path, so the next recall can use it.
      if (ready === null) o.ctx.waitUntil(probeReranker(o.env));
      return { route: "not-ready" };
    }
  }
  const started = performance.now();
  try {
    const ids = selectRerankIds(o.direct, o.root, o.tuning?.maxCandidates);
    const content = await o.loadContent(ids);
    const candidates = ids.flatMap(id => {
      const text = queryRelevantWindow(content.get(id) ?? "", [...o.evidenceTokens], o.tuning?.excerptChars ?? RERANK_EXCERPT_CHARS).trim();
      return text ? [{ parentId: id, text }] : [];
    });
    if (candidates.length < 3) return { route: "too-few", ms: performance.now() - started };
    const scores = await scoreRerankCandidates(o.query, candidates, o.env);
    return { route: "applied", percentiles: percentilesFromScores(candidates.map(c => c.parentId), scores), ms: performance.now() - started };
  } catch (e) {
    console.error(`Reranker failed (keeping the heuristic order): ${e instanceof RerankTimeout ? "timeout" : e instanceof Error ? e.message : "unknown"}`);
    return { route: e instanceof RerankTimeout ? "timeout" : "error", ms: performance.now() - started };
  }
}
