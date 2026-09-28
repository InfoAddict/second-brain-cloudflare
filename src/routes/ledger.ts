/**
 * Decision ledger routes (Track 7, T-0089.7.2, T-0089.7.1).
 *
 * GET /decisions and GET /decisions/calibration (Design 4.4, Task 10).
 * POST /decisions/outcome, the REST twin of resolve(id, "outcome", result, note?) (Design 4.2, Task 8).
 */
import type { Env } from "../env";
import { json, intParam } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { scopeWhere } from "../lib/scope";
import { resolveDecisionOutcome } from "../memory/actions";
import type { DecisionOutcomeResult } from "../decisions/outcome";
import {
  calibrationQuery, decisionsActionable, decisionsListQuery, parseDecisionListRow, parseDecisionOutcomeRow,
  type DecisionState,
} from "../decisions/queries";
import { calibrate } from "../decisions/calibration";
import { resolveConfig } from "../config";

const OUTCOME_RESULTS = new Set(["right", "wrong", "mixed", "unknown"]);
const DECISION_STATES: ReadonlySet<string> = new Set(["open", "resolved", "all"]);
const CALIBRATION_SOURCES: ReadonlySet<string> = new Set(["all", "stated", "inferred"]);

export async function handleLedgerRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /decisions — the decision log (Design 4.4). One statement: rows, total (window
  // function) and edited_since_recorded (an EXISTS) together.
  if (url.pathname === "/decisions" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const stateParam = url.searchParams.get("state") ?? "open";
    if (!DECISION_STATES.has(stateParam)) return json({ ok: false, error: "state must be one of: open, resolved, all" }, 400);

    const limit = intParam(url, "limit", { fallback: 50, min: 1, max: 100 });
    if (limit instanceof Response) return limit;
    const offset = intParam(url, "offset", { fallback: 0, min: 0 });
    if (offset instanceof Response) return offset;

    const scope = scopeWhere(auth);
    const actionable = decisionsActionable(auth);
    const { sql, bindings } = decisionsListQuery(scope, actionable, { state: stateParam as DecisionState, limit, offset });
    const { results } = await env.DB.prepare(sql).bind(...bindings).all();
    const rows = (results as Record<string, unknown>[]).map(parseDecisionListRow);

    return json({
      ok: true,
      decisions: rows.map(({ id, content, created_at, confidence, confidence_source, outcome, review_at, rearms, edited_since_recorded }) => ({
        id, content, created_at, confidence, confidence_source, outcome, review_at, rearms, edited_since_recorded,
      })),
      total: (results[0] as Record<string, unknown> | undefined)?.total as number ?? 0,
      limit,
      offset,
    });
  }

  // GET /decisions/calibration (Design 4.3, 4.4). One statement, reading only idx_entries_ledger rows.
  if (url.pathname === "/decisions/calibration" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const source = url.searchParams.get("source") ?? "all";
    if (!CALIBRATION_SOURCES.has(source)) return json({ ok: false, error: "source must be one of: all, stated, inferred" }, 400);

    const cfg = await resolveConfig(env);
    const scope = scopeWhere(auth);
    const { sql, bindings } = calibrationQuery(scope, decisionsActionable(auth));
    const { results } = await env.DB.prepare(sql).bind(...bindings).all();
    let rows = (results as { tags: string }[]).map(r => parseDecisionOutcomeRow(r.tags));
    if (source !== "all") rows = rows.filter(r => r.source === source);

    const result = calibrate(rows, { minN: cfg.CALIBRATION_MIN_N, minBucketN: cfg.CALIBRATION_MIN_BUCKET_N, minTopicN: cfg.CALIBRATION_MIN_TOPIC_N });
    return json({ ok: true, ...result });
  }

  // POST /decisions/outcome — records how a logged decision turned out (Design 4.2).
  if (url.pathname === "/decisions/outcome" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; result?: string; note?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (!body.result || !OUTCOME_RESULTS.has(body.result)) {
      return json({ ok: false, error: "result must be one of: right, wrong, mixed, unknown" }, 400);
    }
    if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 1000)) {
      return json({ ok: false, error: "note must be a string of at most 1000 characters" }, 400);
    }

    const outcome = await resolveDecisionOutcome(
      env, ctx, auth, body.id.trim(), body.result as DecisionOutcomeResult, body.note, { actorId: auth.userId, channel: "rest" },
    );
    if (!outcome.ok) return json({ ok: false, error: outcome.error }, outcome.status);
    return json({ ok: true, id: outcome.id, message: outcome.reply });
  }

  return null;
}
