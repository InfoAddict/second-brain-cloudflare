/**
 * Standing memory routes (Track 7, T-0089.7.1).
 *
 * GET /standing (Design 2.12) lands in Task 11 (Lane D). This task (8) adds
 * POST /standing/stop (Design 2.2), the REST twin of resolve(id, "stop_standing").
 */
import type { Env } from "../env";
import { json } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { resolveEntryAction } from "../memory/actions";

export async function handleStandingRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // POST /standing/stop — removes standing:active only, versioned and undoable (Design 2.2).
  if (url.pathname === "/standing/stop" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);

    const result = await resolveEntryAction(env, ctx, auth, body.id.trim(), "stop_standing", undefined, { actorId: auth.userId, channel: "rest" });
    if (!result.ok) return json({ ok: false, error: result.error }, result.status);
    return json({ ok: true, id: result.id });
  }

  return null;
}
