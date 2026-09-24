import { RERANK_AMBIGUITY_MARGIN, RERANK_BREAKER_FAILURES, RERANK_PROBE_TIMEOUT_MS, RERANK_BLEND_FLOOR, RERANK_BLEND_WEIGHT, RERANK_EXCERPT_CHARS, RERANK_MAX_CANDIDATES, RERANK_MAX_DIRECT, RERANK_MODEL, RERANK_NOT_READY_TTL_S, RERANK_QUERY_MAX_CHARS, RERANK_READY_CACHE_MS, RERANK_READY_KV_KEY, RERANK_READY_TTL_S, RERANK_TIMEOUT_MS } from "../constants";
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
* A token that names one thing exactly, which the keyword arm already answers: `#` or `_` anywhere, a digit next
 * to a letter (v1.2, abc123, 40mg), a hyphen-joined id or date with a digits-only segment (ENG-1234, 2026-09-24), a dotted
 * name or version (config.yaml, 2.81.0, 10.0.0.1).
 * Prose is not a lookup: sentence punctuation is not part of the token ("cells."), a plain hyphenated word
 * ("tissue-resident") is a word, and so are a bare year (2026), a plain number or percentage (32%, 1.5), and a
 * dotted abbreviation of short segments (U.S., e.g.).
 */
export function lookupShaped(token: string): boolean {
  const t = token.replace(/[.,;:!?)\]"']+$/u, "");
  if (/[#_]/.test(t)) return true;
  if (/\p{L}\d|\d\p{L}/u.test(t)) return true;
  if (t.includes("-")) {
    // Hyphen-joined ids (ENG-1234, INV-88213, SN-AX-880415, 20260714-add-ledger-idx, release-2026.09.88) and dates
    // (2026-09-24): a number-only segment beside another segment. Plain hyphenated words have none.
    const parts = t.split("-").filter(Boolean);
    const numeric = parts.filter(x => /^\d+(\.\d+)*$/.test(x)).length;
    if (parts.length > 1 && (numeric === parts.length || (numeric > 0 && parts.some(x => /\p{L}/u.test(x))))) return true;
  }
  // Dotted names and versions (config.yaml, registry.example.com/x:2.81.0, 1.88.4-beta.3, 10.0.0.1): an inner dot with a
  // three-letter word, or two inner dots. U.S., e.g. and 1.5 have neither.
  const innerDots = (t.match(/[\p{L}\p{N}]\.(?=[\p{L}\p{N}])/gu) ?? []).length;
  if (innerDots >= 2) return true;
  return innerDots === 1 && /\p{L}{3,}\.[\p{L}\p{N}]|[\p{L}\p{N}]\.\p{L}{3,}/u.test(t);
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

/**
 * Reorders only what the model saw. A scored parent's heuristic score is scaled by max(floor, 1 + weight * (2p - 1));
 * parents outside the scored batch keep their scores and their order, and every scored parent ends up above every
 * unscored one (the scored block is scaled, as a whole and by one factor, just clear of the best unscored score), so
 * the model can never demote a candidate below one it did not rank.
 */
export function blendRerankerScores<T extends VectorizeMatch>(
  ranked: readonly T[], percentiles: ReadonlyMap<string, number>, weight = RERANK_BLEND_WEIGHT, floor = RERANK_BLEND_FLOOR,
  keywordEvidence: ReadonlySet<string> = new Set(),
): T[] {
  // A keyword-evidence parent enters the block at the edge of the fused candidates (the lowest heuristic score among the
  // scored ones that are not evidence), where the model's percentile then moves it. Its own fused score is a tail rank
  // from a different arm; left as is, even the top percentile's doubling would leave a match the model rated best buried.
  const edge = Math.min(...ranked.filter(m => percentiles.has(parentOf(m)) && !keywordEvidence.has(parentOf(m))).map(m => m.score));
  const scored: T[] = [], unscored: T[] = [];
  for (const match of ranked) {
    const id = parentOf(match);
    const p = percentiles.get(id);
    if (p === undefined) unscored.push({ ...match });
    else {
      const base = keywordEvidence.has(id) && Number.isFinite(edge) ? Math.max(match.score, edge) : match.score;
      scored.push({ ...match, score: base * Math.max(floor, 1 + weight * (2 * p - 1)) });
    }
  }
  const byScore = (a: T, b: T) => b.score - a.score || a.id.localeCompare(b.id);
  scored.sort(byScore);
  unscored.sort(byScore);
  if (scored.length && unscored.length) {
    // Scale (not shift) the scored block so its minimum clears the best unscored score: ratios inside the block, which
    // MMR's relevance/diversity trade reads, are preserved exactly.
    const lowest = scored[scored.length - 1].score, best = unscored[0].score;
    if (lowest < best) {
      if (lowest > 0) {
        const factor = (best / lowest) * (1 + 1e-9);
        for (const m of scored) m.score *= factor;
      } else {
        // Not reachable from rerankWithTimeDecay (positive score times non-negative factors), but a multiplier means nothing
        // on a non-positive score: shift instead, which puts the minimum just above the best unscored score, and let the
        // model's percentile break the ties a block of equal (e.g. all-zero) scores would otherwise leave.
        for (const m of scored) m.score += (best - lowest) + 1e-9 + 1e-12 * (percentiles.get(parentOf(m)) ?? 0);
      }
    }
  }
  scored.sort(byScore);
  return [...scored, ...unscored];
}

export interface RerankCandidate { parentId: string; text: string }

/**
 * The scored set: up to `max` parents (RERANK_MAX_CANDIDATES). Extra graph-root parents fill the seats after the direct
 * ones. A parent the keyword arm found with every distilled query term in its text ("keyword evidence", already ordered
 * by fused rank) is always scored, up to the batch's five spare seats, and each takes the seat of the lowest-ranked
 * fused candidate, so the batch never grows. Without this, an exact rare-term match that fusion left at the tail of
 * the pool would stay unscored and be ranked below the whole scored block.
 * Ids only: the passage text comes from a scoped D1 read, never from Vectorize or keyword metadata.
 */
/** How many fused candidates are scored for a batch of `max`: the head the keyword-evidence gate and the selection both cut at. */
export const rerankDirectCap = (max = RERANK_MAX_CANDIDATES): number => max - (RERANK_MAX_CANDIDATES - RERANK_MAX_DIRECT);

export function selectRerankIds(direct: readonly VectorizeMatch[], root: readonly VectorizeMatch[], max = RERANK_MAX_CANDIDATES, keywordEvidence: readonly string[] = []): string[] {
  const spare = RERANK_MAX_CANDIDATES - RERANK_MAX_DIRECT;
  const directCap = rerankDirectCap(max);
  const directParents = [...new Set(direct.map(parentOf))];
  const head = new Set(directParents.slice(0, directCap));
  const extras = keywordEvidence.filter(id => !head.has(id)).slice(0, spare);
  const ids = new Set<string>(directParents.slice(0, directCap - extras.length));
  for (const id of extras) ids.add(id);
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
  try {
    // Inside the try: a synchronous throw from AI.run (absent binding, a mock returning a non-promise) must still clear the timer.
    const call = Promise.resolve((env.AI as unknown as { run(model: string, input: unknown): unknown })
      .run(RERANK_MODEL, { query: query.slice(0, RERANK_QUERY_MAX_CHARS), contexts: candidates.map(c => ({ text: c.text })), top_k: candidates.length }));
    call.catch(() => undefined);
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
// This isolate's own record of the last verdict, kept for as long as the KV latch would live, so a KV write that
// failed (or has not propagated) can never turn into a re-probe on every recall.
let localLatch: { ready: boolean; until: number } | null = null;
let probeInFlight: Promise<ProbeResult> | null = null;
let consecutiveFailures = 0;
export function resetRerankReadyMemo(): void { readyCache = null; localLatch = null; probeInFlight = null; consecutiveFailures = 0; }

const rememberVerdict = (ready: boolean): void => {
  localLatch = { ready, until: Date.now() + (ready ? RERANK_READY_TTL_S : RERANK_NOT_READY_TTL_S) * 1000 };
  readyCache = null;
};

/** true = probe passed, false = probe failed, null = never probed. */
export async function rerankReadiness(env: Env): Promise<boolean | null> {
  const now = Date.now();
  if (readyCache && now - readyCache.at < RERANK_READY_CACHE_MS) return readyCache.ready;
  try {
    const raw = await env.OAUTH_KV.get(RERANK_READY_KV_KEY);
    const ready = raw === "1" ? true : raw === "0" ? false : localLatch && localLatch.until > now ? localLatch.ready : null;
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

/** A production-shaped request: a full batch of full-length passages and a full-length query, so a size limit the small ranking check cannot reach still latches the model off. */
const fullBatch = () => ({
  query: "what should I remember about the project decision and why did the team choose that approach ".repeat(4).slice(0, RERANK_QUERY_MAX_CHARS),
  candidates: Array.from({ length: RERANK_MAX_CANDIDATES }, (_, i) => ({
    parentId: String(i),
    text: `Passage ${i}: ${"notes about a planning meeting, the budget, and follow-up actions for the quarter. ".repeat(6)}`.slice(0, RERANK_EXCERPT_CHARS),
  })),
});

export type ProbeResult = { ok: true; margin: number } | { ok: false; reason: string };

/**
 * The model contract probe. Two calls with fixed, non-private requests: a small one whose answer must validate against the
 * documented shape and put the relevant passage ahead of the others by PROBE.margin logits, then a full-size batch (RERANK_MAX_CANDIDATES
 * passages of RERANK_EXCERPT_CHARS each, a query of RERANK_QUERY_MAX_CHARS) that must come back complete. Writes the readiness latch
 * either way ("1" for a week, "0" for six hours) so recall never runs an unverified model. Never throws.
 */
export function probeReranker(env: Env): Promise<ProbeResult> {
  // One probe per isolate at a time: concurrent recalls that read "never probed" share it instead of each spending a call.
  probeInFlight ??= runProbe(env).finally(() => { probeInFlight = null; });
  return probeInFlight;
}

async function runProbe(env: Env): Promise<ProbeResult> {
  let result: ProbeResult;
  try {
    const scores = await scoreRerankCandidates(PROBE.query, PROBE.contexts.map((c, i) => ({ parentId: String(i), text: c.text })), env, RERANK_PROBE_TIMEOUT_MS);
    const others = scores.filter((_, i) => i !== PROBE.relevant);
    const margin = scores[PROBE.relevant] - Math.max(...others);
    result = margin >= PROBE.margin ? { ok: true, margin } : { ok: false, reason: "the relevant passage did not clearly outrank the unrelated ones" };
    if (result.ok) {
      // Any rejection, truncation or wrong length throws here and latches the model off.
      const big = fullBatch();
      const started = performance.now();
      await scoreRerankCandidates(big.query, big.candidates, env, RERANK_PROBE_TIMEOUT_MS);
      // The probe may wait longer than a recall, but a service that cannot answer a full batch inside the recall budget
      // would pass here and then trip the breaker on real traffic, every time it is re-probed.
      const took = performance.now() - started;
      if (took > RERANK_TIMEOUT_MS) result = { ok: false, reason: `a full batch took ${Math.round(took)} ms, over the ${RERANK_TIMEOUT_MS} ms recall budget` };
    }
  } catch (e) {
    result = { ok: false, reason: e instanceof Error ? e.message : "probe failed" };
  }
  try {
    rememberVerdict(result.ok);
    await env.OAUTH_KV.put(RERANK_READY_KV_KEY, result.ok ? "1" : "0", { expirationTtl: result.ok ? RERANK_READY_TTL_S : RERANK_NOT_READY_TTL_S });
  } catch (e) {
    console.error("Reranker ready latch write failed (non-fatal):", e);
  }
  if (!result.ok) console.error(`Reranker probe failed (recall stays on the heuristic order): ${result.reason}`);
  return result;
}

/** Circuit breaker: after RERANK_BREAKER_FAILURES consecutive timeouts or errors, latch the model off here and in KV until the probe is retried. */
function tripBreaker(o: RerankStepInput): void {
  consecutiveFailures = 0;
  rememberVerdict(false);
  console.error("Reranker circuit breaker open: recall stays on the heuristic order until the next probe");
  o.ctx.waitUntil(o.env.OAUTH_KV.put(RERANK_READY_KV_KEY, "0", { expirationTtl: RERANK_NOT_READY_TTL_S })
    .catch((e: unknown) => console.error("Reranker breaker latch write failed (non-fatal):", e)));
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
  /** Parents the keyword arm found with every distilled query term in their text, best fused rank first; resolved only once the model is going to be called, because a single common word may need one df read. */
  keywordEvidence?: () => Promise<readonly string[]>;
  /** Eval-only overrides (RecallVariantFlags.rerankTuning); production passes none. */
  tuning?: RerankTuning;
  /** Scoped D1 passage text for ids not already in hand; the caller applies the tenant clause. */
  loadContent(ids: string[]): Promise<Map<string, string>>;
}

export interface RerankStepResult { route: RerankRoute; percentiles?: Map<string, number>; ms?: number; evidence?: string[] }

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
      if (ready === null && !probeInFlight) o.ctx.waitUntil(probeReranker(o.env));
      return { route: "not-ready" };
    }
  }
  const started = performance.now();
  try {
    const evidence = o.keywordEvidence ? [...await o.keywordEvidence()] : [];
    const ids = selectRerankIds(o.direct, o.root, o.tuning?.maxCandidates, evidence);
    const content = await o.loadContent(ids);
    const candidates = ids.flatMap(id => {
      const text = queryRelevantWindow(content.get(id) ?? "", [...o.evidenceTokens], o.tuning?.excerptChars ?? RERANK_EXCERPT_CHARS).trim();
      return text ? [{ parentId: id, text }] : [];
    });
    if (candidates.length < 3) return { route: "too-few", ms: performance.now() - started };
    const scores = await scoreRerankCandidates(o.query, candidates, o.env, o.tuning?.timeoutMs);
    consecutiveFailures = 0;
    const ms = performance.now() - started;
    // The first real deploy measures Workers AI latency from these lines (wrangler tail / Workers Logs).
    console.info(JSON.stringify({ rerank: "applied", ms: Math.round(ms), n: candidates.length }));
    return { route: "applied", percentiles: percentilesFromScores(candidates.map(c => c.parentId), scores), ms, evidence };
  } catch (e) {
    const route = e instanceof RerankTimeout ? "timeout" : "error";
    const ms = performance.now() - started;
    console.error(JSON.stringify({ rerank: route, ms: Math.round(ms), reason: route === "error" && e instanceof Error ? e.message.slice(0, 120) : undefined }));
    if (++consecutiveFailures >= RERANK_BREAKER_FAILURES) tripBreaker(o);
    return { route, ms };
  }
}
