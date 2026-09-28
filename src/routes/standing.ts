/**
 * Standing memory routes (Track 7, T-0089.7.1).
 *
 * GET /standing (Design 2.12): see what fires. POST /standing/stop (Design 2.2)
 * is the REST twin of resolve(id, "stop_standing").
 */
import type { Env } from "../env";
import { json, readWorkspaceParam, readTeamQueryParam } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { resolveEntryAction } from "../memory/actions";
import { resolveConfig } from "../config";
import { layerOf, readScopeWorkspaces, scopeWhereForRead } from "../lib/scope";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import { isHeld } from "../quarantine/tags";
import { readStandingCaches, type StandingCacheConfig } from "../standing/cache";
import { currentValidityAt } from "../memory/validity";

export async function handleStandingRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /standing — every standing:active row in the readable scope, with why it does or does not
  // fire (Design 2.12). One D1 statement plus one bulk KV read (readStandingCaches, isolate-memoed).
  if (url.pathname === "/standing" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;
    const workspace = readWorkspaceParam(url);
    if (workspace instanceof Response) return workspace;
    const team = readTeamQueryParam(url, identity, workspace);
    if (team instanceof Response) return team;

    const cfg = await resolveConfig(env);
    const readScope = { layer: workspace, teamId: team };
    const scope = scopeWhereForRead(identity, readScope);
    // A deprecated or ended row (a contradiction's loser, or one whose window closed) keeps whatever
    // other tags it had, including standing:active — excluded here exactly as the cache build
    // excludes it (Design 2.4), so this list only shows what a person would still call standing.
    // validity: current: matches the cache build's own filter (Design 2.4/2.6)
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, created_at, workspace_id, actor_id, vector_ids FROM entries
        WHERE instr(lower(tags), '"standing:active"') > 0 AND tags NOT LIKE '%"status:deprecated"%'
          AND ${currentValidityAt("", "?")} AND ${scope.clause}
        ORDER BY created_at ASC, id ASC LIMIT ?`,
    ).bind(Date.now(), ...scope.bindings, cfg.STANDING_MAX * 2).all();
    const rows = results as { id: string; content: string; tags: string; created_at: number; workspace_id: string; actor_id: string; vector_ids: string }[];

    const workspaceIds = readScopeWorkspaces(identity, readScope);
    const caches = await readStandingCaches(env, ctx, cfg as StandingCacheConfig, workspaceIds);
    const cachedIds = new Set(caches.flatMap(c => c.items.map(i => i.id)));

    // over_limit is decided per workspace: the cache build keeps only the STANDING_MAX oldest rows
    // OF THAT WORKSPACE (Design 2.4's ORDER BY created_at ASC LIMIT), never a cross-workspace rank.
    const rankInWorkspace = new Map<string, number>();
    const seenPerWorkspace = new Map<string, number>();
    for (const row of rows) {
      const n = seenPerWorkspace.get(row.workspace_id) ?? 0;
      rankInWorkspace.set(row.id, n);
      seenPerWorkspace.set(row.workspace_id, n + 1);
    }

    const companyRows = rows.filter(r => layerOf(identity, r.workspace_id) === "company");
    const labelMap = await lookupActorLabels(env, companyRows.map(r => r.actor_id ?? ""));

    return json({
      ok: true,
      standing: rows.map(row => {
        const tags = JSON.parse(row.tags ?? "[]") as string[];
        const held = isHeld(tags);
        const firing = !held && cachedIds.has(row.id);
        const rank = rankInWorkspace.get(row.id) ?? 0;
        const indexed = (JSON.parse(row.vector_ids || "[]") as string[]).length > 0;
        const reason = firing
          ? undefined
          : held
            ? "held" as const
            : rank >= cfg.STANDING_MAX
              ? "over_limit" as const
              : !indexed
                ? "not_indexed_yet" as const
                : "pending_refresh" as const;
        return {
          id: row.id,
          content: row.content.slice(0, 200),
          created_at: row.created_at,
          project: tags.find(t => t.startsWith("project:"))?.slice("project:".length) ?? null,
          workspace: layerOf(identity, row.workspace_id),
          actor_name: layerOf(identity, row.workspace_id) === "company"
            ? resolveActorLabel(row.actor_id ?? "", labelMap, { viewerId: identity.userId })
            : null,
          firing,
          ...(reason ? { reason } : {}),
        };
      }),
    });
  }

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
