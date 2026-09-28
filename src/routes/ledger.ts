/**
 * Decision ledger routes (Track 7, T-0089.7.2).
 *
 * GET /decisions and GET /decisions/calibration (Design 4.4) land in Task 10.
 * This task (8) adds POST /decisions/outcome, the REST twin of
 * resolve(id, "outcome", result, note?) (Design 4.2).
 */
import type { Env } from "../env";
import { json } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { resolveDecisionOutcome } from "../memory/actions";
import type { DecisionOutcomeResult } from "../decisions/outcome";

const OUTCOME_RESULTS = new Set(["right", "wrong", "mixed", "unknown"]);

export async function handleLedgerRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
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
