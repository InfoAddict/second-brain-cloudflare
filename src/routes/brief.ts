import type { Env } from "../env";
import { json, readWorkspaceParam, readTeamQueryParam } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { readResurfaceState, withDismissed, writeResurfaceState } from "../runtime/resurface-state";
import { computeBrief, computeLeanBrief } from "../brief/compute";
import { readProjectParam } from "./project-param";

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
  // ?lean=1 is the session-start hook's read: due and open commitments only, no resurface, topics
  // or activity, so it touches only the rows those queues hold. It honours ?workspace= and ?team=.
  if (url.searchParams.get("lean") === "1") {
    const layer = readWorkspaceParam(url);
    if (layer instanceof Response) return layer;
    const teamId = readTeamQueryParam(url, auth, layer);
    if (teamId instanceof Response) return teamId;
    const projectRows = await readProjectParam(env, auth, url, { layer, teamId });
    if (projectRows instanceof Response) return projectRows;
    return json(await computeLeanBrief(env, auth, projectRows, layer, teamId));
  }
  const projectRows = await readProjectParam(env, auth, url);
  if (projectRows instanceof Response) return projectRows;
  return json(await computeBrief(env, auth, url.searchParams.get("preview") === "1", projectRows));
}
