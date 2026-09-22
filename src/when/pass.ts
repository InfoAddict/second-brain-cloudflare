/**
 * Nightly capped AI extraction: for entries the free regex pass
 * (src/when/heuristic.ts) could not anchor, ask the model whether this reads
 * as a commitment and, if so, when it is due.
 *
 * Budgeted hard, like every nightly pass sharing one scheduled() invocation:
 * at most WHEN_EXTRACT_PER_NIGHT model calls and, regardless of how many of
 * those are commitments, exactly one SELECT plus at most one batched UPDATE —
 * two D1 statements, well inside the ten this pass is held to.
 *
 * The cursor is a KV keyset over (created_at, id), mirroring
 * src/insight/candidates.ts's ACCRUAL_CURSOR_KEY: cheap, and immune to a tie
 * group of same-millisecond captures being split across nights.
 *
 * Robustness contract mirrors src/insight/reason.ts: "declined" (the model
 * gave a real answer and it was not a due commitment) and "failed" (the call
 * itself produced nothing to judge) are different outcomes. A declined
 * candidate has been looked at and the cursor may pass it; a failed one has
 * not, and the pass stops there rather than risk skipping it — the whole
 * point of a keyset cursor is that nothing between the old position and the
 * new one is silently missed.
 */
import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { WHEN_PASS_MAX_TOKENS } from "../constants";
import { readStreamText } from "../lib/ai";
import { initializeDatabase } from "../db/init";
import { OPEN_LOOP_SQL } from "../memory/loops";
import type { ScopeClause } from "../lib/scope";

/** Model calls spent per night, hard ceiling. */
export const WHEN_EXTRACT_PER_NIGHT = 20;

/** Below this the model's own confidence says not to act on it. */
export const WHEN_CONFIDENCE_THRESHOLD = 0.7;

/** Overdue commitments are still worth surfacing; this bounds how overdue. */
export const WHEN_MAX_PAST_MS = 30 * 24 * 60 * 60 * 1000;

export const WHEN_CURSOR_KEY = "when:cursor";

export interface WhenCursor {
  createdAt: number;
  id: string;
}

export interface WhenCandidate {
  id: string;
  content: string;
  created_at: number;
}

/** Same tolerance as insight/candidates.ts's parseCursor: unreadable means "start from the top". */
export function parseWhenCursor(raw: string | null): WhenCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.createdAt === "number" && typeof parsed?.id === "string") {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // fall through to null
  }
  return null;
}

/** Read-only: GET /extract/dry-run uses this to preview from the same position the real pass would start at. */
export async function readWhenCursor(env: Env): Promise<WhenCursor | null> {
  try {
    return parseWhenCursor(await env.OAUTH_KV.get(WHEN_CURSOR_KEY));
  } catch (e) {
    console.error("When-extraction cursor read failed; starting from the top (non-fatal):", e);
    return null;
  }
}

async function writeWhenCursor(env: Env, row: { created_at: number; id: string }): Promise<void> {
  try {
    const cursor: WhenCursor = { createdAt: row.created_at, id: row.id };
    await env.OAUTH_KV.put(WHEN_CURSOR_KEY, JSON.stringify(cursor));
  } catch (e) {
    console.error("When-extraction cursor write failed (non-fatal):", e);
  }
}

function candidateSql(hasCursor: boolean, scopeClause: string | null): string {
  const cursorClause = hasCursor ? `AND (created_at > ? OR (created_at = ? AND id > ?))` : "";
  const sliceClause = scopeClause ? `AND ${scopeClause}` : "";
  // scope-exempt: cron: the nightly pass's own single-workspace slice is folded into `scope` by the caller, same exemption shape as the other nightly passes; a direct/manual caller with no slice walks the whole corpus, same as before v3. GET /extract/dry-run instead passes a real scopeWhere(auth), so that path IS scoped.
  return `SELECT id, content, created_at FROM entries
          WHERE when_at IS NULL AND when_source IS NULL
            AND (${OPEN_LOOP_SQL} OR tags LIKE '%"volatility:volatile"%')
            ${cursorClause}
            ${sliceClause}
          ORDER BY created_at ASC, id ASC
          LIMIT ${WHEN_EXTRACT_PER_NIGHT}`;
}

/**
 * Candidates from just past `cursor`, capped at `limit` (WHEN_EXTRACT_PER_NIGHT
 * for the real pass; GET /extract/dry-run passes its own, smaller N). Exported
 * so the dry-run route reads the identical prefilter the pass itself uses.
 *
 * `scope` is a plain WHERE fragment, not a bare workspace id: the nightly
 * pass folds its single rotation slice into one (`workspace_id = ?`),
 * while GET /extract/dry-run passes a real scopeWhere(auth) — personal plus
 * every company workspace the caller can read, an IN clause the pass itself
 * never needs.
 */
export async function fetchWhenCandidates(
  env: Env,
  cursor: WhenCursor | null,
  scope: ScopeClause | null,
  limit: number = WHEN_EXTRACT_PER_NIGHT,
): Promise<WhenCandidate[]> {
  const hasCursor = cursor != null;
  const bindings: (string | number)[] = [];
  if (cursor) bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  if (scope) bindings.push(...scope.bindings);
  const { results } = await env.DB.prepare(candidateSql(hasCursor, scope?.clause ?? null)).bind(...bindings).all();
  // LIMIT is baked into candidateSql at WHEN_EXTRACT_PER_NIGHT; a caller
  // asking for fewer (GET /extract/dry-run) just reads fewer rows back.
  return (results as unknown as WhenCandidate[]).slice(0, limit);
}

export type CommitmentOutcome =
  | { outcome: "commitment"; what: string; dueAt: number; confidence: number }
  | { outcome: "declined" }
  | { outcome: "failed" };

const ENTRY_EXCERPT_CHARS = 800;
const MAX_WHAT_CHARS = 120;

function isReadableJsonObject(raw: string): boolean {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return false;
  try {
    JSON.parse(match[0]);
    return true;
  } catch {
    return false;
  }
}

function parseCommitmentJson(raw: string): {
  isCommitment: boolean; what: string; dueAt: number | null; confidence: number;
} | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed.is_commitment !== "boolean") return null;

  const confidence = typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
    ? parsed.confidence : 0;
  const what = typeof parsed.what === "string" ? parsed.what.trim().slice(0, MAX_WHAT_CHARS) : "";
  let dueAt: number | null = null;
  if (typeof parsed.due_at === "string" && parsed.due_at.trim()) {
    const at = Date.parse(parsed.due_at.trim());
    if (!Number.isNaN(at)) dueAt = at;
  }

  return { isCommitment: parsed.is_commitment, what, dueAt, confidence };
}

/**
 * One entry in, at most one judgment out. `referenceDate` anchors relative
 * phrases in the memory ("next Friday", "in two weeks") to an absolute date —
 * without it the model has no "today" to resolve them against.
 */
export async function judgeCommitment(
  content: string,
  referenceDate: number,
  env: Env,
  config: Readonly<Config> = DEFAULTS,
): Promise<CommitmentOutcome> {
  const excerpt = content.slice(0, ENTRY_EXCERPT_CHARS);
  const today = new Date(referenceDate).toISOString().slice(0, 10);

  const prompt = `You are reading one memory from a person's second brain, written on or before ${today}.

Memory:
${excerpt}

Does this describe something the person needs to DO by a specific point in time — a deadline, a task with a due date, an appointment, a commitment they made? A general fact, a preference, or something that already happened with no future action is not a commitment.

If it is a commitment, say what needs to be done in a few words, written as an instruction, at most 120 characters. Give the date it is due as an absolute date (YYYY-MM-DD), resolving any relative phrase ("next Friday", "in two weeks") against ${today} as today. If you cannot pin down a specific date, this is not a commitment for this purpose.

Respond with JSON only. No text outside the JSON object.
{"is_commitment": <true or false>, "what": "<short instruction, or empty string>", "due_at": "<YYYY-MM-DD, or null>", "confidence": <0 to 1>}`;

  let raw = "";
  try {
    // config.WHEN_LLM_MODEL, deliberately not config.LLM_MODEL — see the cost
    // comment on constants.WHEN_PASS_MAX_TOKENS for why this defaults to the
    // same model INSIGHT_LLM_MODEL uses.
    const stream = await (env.AI as any).run(config.WHEN_LLM_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: WHEN_PASS_MAX_TOKENS,
      stream: true,
    });
    raw = await readStreamText(stream as ReadableStream);
  } catch (e) {
    // The call itself produced nothing to judge — stays eligible to be asked again.
    console.error("When-extraction call failed (non-fatal):", e);
    return { outcome: "failed" };
  }

  // No JSON object at all — prose, or an object truncated mid-answer — is not
  // a judgement to record, same reasoning as reason.ts's identical guard.
  if (!isReadableJsonObject(raw)) return { outcome: "failed" };

  const parsed = parseCommitmentJson(raw);
  if (!parsed) return { outcome: "declined" };
  if (!parsed.isCommitment) return { outcome: "declined" };
  if (parsed.confidence < WHEN_CONFIDENCE_THRESHOLD) return { outcome: "declined" };
  if (parsed.dueAt === null) return { outcome: "declined" }; // no anchor, nothing to persist
  if (!parsed.what) return { outcome: "declined" };
  // Overdue is still worth surfacing (the /due feed's whole "overdue" bucket
  // depends on it), but only within reason — a model hallucinating a date
  // decades back is a bad extraction, not a genuinely ancient commitment.
  if (referenceDate - parsed.dueAt > WHEN_MAX_PAST_MS) return { outcome: "declined" };

  return { outcome: "commitment", what: parsed.what, dueAt: parsed.dueAt, confidence: parsed.confidence };
}

export interface WhenPassSummary {
  whenExtracted: number;
  whenJudged: number;
}

/**
 * `workspaceId` narrows the candidate query to one workspace's ring slice
 * (v3 Team Edition), same convention as src/staleness/pass.ts. Undefined/null
 * — every direct and manual caller — scans the whole corpus.
 */
export async function runWhenExtractPass(
  env: Env,
  _ctx: ExecutionContext,
  workspaceId?: string | null,
): Promise<WhenPassSummary> {
  await initializeDatabase(env);
  const cfg = await resolveConfig(env);
  const now = Date.now();

  const cursor = await readWhenCursor(env);

  let candidates: WhenCandidate[] = [];
  try {
    const slice: ScopeClause | null = workspaceId != null ? { clause: "workspace_id = ?", bindings: [workspaceId] } : null;
    candidates = await fetchWhenCandidates(env, cursor, slice, WHEN_EXTRACT_PER_NIGHT);
  } catch (e) {
    console.error("When-extraction candidate query failed (non-fatal):", e);
    return { whenExtracted: 0, whenJudged: 0 };
  }

  let whenJudged = 0;
  let whenExtracted = 0;
  const writes: D1PreparedStatement[] = [];
  let lastExamined: { created_at: number; id: string } | null = null;

  for (const candidate of candidates) {
    const verdict = await judgeCommitment(candidate.content, now, env, cfg);
    if (verdict.outcome === "failed") break; // stop; do not advance the cursor past this one
    lastExamined = candidate;
    whenJudged++;
    if (verdict.outcome === "commitment") {
      writes.push(
        env.DB.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'model' WHERE id = ?`)
          .bind(verdict.dueAt, candidate.id),
      );
      whenExtracted++;
    }
  }

  // One batch however many writes it carries — the whole reason the loop
  // above collects statements instead of running them as it goes.
  if (writes.length) {
    try {
      await env.DB.batch(writes);
    } catch (e) {
      console.error("When-extraction batch write failed (non-fatal):", e);
    }
  }

  if (lastExamined) await writeWhenCursor(env, lastExamined);

  return { whenExtracted, whenJudged };
}
