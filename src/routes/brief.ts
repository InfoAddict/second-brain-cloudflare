import type { Env } from "../env";
import { json } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { readResurfaceState, withDismissed, writeResurfaceState } from "../runtime/resurface-state";
import { computeBrief } from "../brief/compute";

export async function handleBriefRoutes(request: Request, url: URL, env: Env): Promise<Response | null> {
  if (url.pathname === "/resurface/dismiss" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    const workspaceKey = auth.personalWorkspaceId;
    const state = await readResurfaceState(env, workspaceKey);
    await writeResurfaceState(env, workspaceKey, withDismissed(state, body.id.trim()));
    return json({ ok: true });
  }
  if (url.pathname !== "/brief" || request.method !== "GET") return null;
  const auth = await requireIdentity(request, env);
  if (auth instanceof Response) return auth;
  return json(await computeBrief(env, auth, url.searchParams.get("preview") === "1"));
}
