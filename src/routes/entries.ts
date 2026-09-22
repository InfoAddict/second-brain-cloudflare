import type { Env } from "../env";
import { importExportPayload, parseImportBody, parseImportLimit, parseImportOffset } from "../entries/import";
import { initializeDatabase } from "../db/init";
import { json } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { assertCanMutateEntry, getReadableEntry } from "../lib/entry-access";
import { layerOf, scopeWhere, readTeamParam } from "../lib/scope";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import { forgetEntry } from "../capture/lifecycle";
import { applyStatus } from "../capture/lifecycle";
import { moveEntry, restampVectorWorkspace, type ShareTarget } from "../capture/share";
import { auditEvent } from "../lib/audit";
import { STATUS_VALUES, type MemoryStatus } from "../memory/status";
import { getTagVocabulary } from "../tags/vocabulary";
import { projectRowsOf } from "../projects/registry";

/** Most entries GET /tags?counts=1 reads; matches the /projects counts cap. */
const TAG_COUNTS_SCAN_LIMIT = 5000;

export async function handleEntriesRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /count
  if (url.pathname === "/count" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const scope = scopeWhere(auth);
    const row = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM entries WHERE ${scope.clause}`
    ).bind(...scope.bindings).first() as Record<string, any> | null;
    return json({ count: (row?.count as number) ?? 0 });
  }

  // GET /tags — the dashboard's filter dropdown, refetched on every page load.
  // Reads the same cache recall does (#288): the scan behind it costs 180,000 rows
  // on a 20,000-entry brain, and nothing here is worth that per navigation. Unlike
  // recall this route has no useful degraded answer, so a cold cache is scanned
  // inline rather than answered empty — see getTagVocabulary.
  if (url.pathname === "/tags" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const tags = await getTagVocabulary(env, ctx, auth);
    const counts = url.searchParams.get("counts");
    if (counts !== "1" && counts !== "true") return json(tags);

    // counts=1: the same tags with how many memories carry each. One bounded scan of
    // the caller's rows, tallied here; the cached vocabulary keeps the tag set and order.
    // A capped scan undercounts, so it says so in a header rather than the body shape.
    const scope = scopeWhere(auth);
    const { results } = await env.DB.prepare(
      `SELECT tags FROM entries WHERE ${scope.clause} LIMIT ${TAG_COUNTS_SCAN_LIMIT}`
    ).bind(...scope.bindings).all<{ tags: string }>();
    const tally = new Map<string, number>();
    for (const row of results) {
      let rowTags: unknown;
      try { rowTags = JSON.parse(row.tags); } catch { continue; }
      if (!Array.isArray(rowTags)) continue;
      for (const tag of new Set(rowTags)) {
        if (typeof tag === "string") tally.set(tag, (tally.get(tag) ?? 0) + 1);
      }
    }
    const response = json(tags.map(tag => ({ tag, count: tally.get(tag) ?? 0 })));
    if (results.length >= TAG_COUNTS_SCAN_LIMIT) response.headers.set("X-Counts-Approximate", "1");
    return response;
  }

  // GET /export — complete backup: every entry plus the edges and projects tables. Single
  // unbounded SELECTs are acceptable here: D1 handles tens of thousands of rows in
  // one read and this route runs on explicit user action only. If response size
  // ever becomes a problem, add ?after= cursor support then, not now.
  if (url.pathname === "/export" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    // A member's backup is their readable set — personal plus company — not the
    // whole deployment. Same unbounded-SELECT budget note as below applies.
    const scope = scopeWhere(auth);

    const { results: entryRows } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at, COALESCE(updated_at, created_at) AS last_updated, recall_count, importance_score, contradiction_wins, contradiction_losses FROM entries WHERE ${scope.clause} ORDER BY created_at DESC`
    ).bind(...scope.bindings).all() as { results: Record<string, any>[] };
    const { results: edgeRows } = await env.DB.prepare(
      `SELECT source_id, target_id, type, weight, provenance, created_at FROM edges WHERE ${scope.clause}`
    ).bind(...scope.bindings).all() as { results: Record<string, any>[] };
    const { results: projectRows } = await env.DB.prepare(
      `SELECT id, workspace_id, name, description, aliases, status, created_at, updated_at FROM projects WHERE ${scope.clause} ORDER BY created_at ASC, workspace_id ASC, id ASC`
    ).bind(...scope.bindings).all();

    // vector_ids are deliberately excluded — they're deployment-specific and an
    // import tool re-embeds anyway. Tags are parsed so the file holds real arrays.
    //
    // updated_at is carried because it is load-bearing on the way back in, not for
    // display: recall reads it as the entry's age (src/recall/search.ts) and the
    // staleness pass selects on it (src/staleness/pass.ts). Without it a restore
    // silently rewrites every entry's last-touched time to its creation time, so
    // anything edited long after it was written comes back looking untouched —
    // ranked staler than it is, and eligible for a staleness verdict sooner.
    // Coalesced in SQL because rows written before that column existed hold NULL, and
    // the export should carry a number the importer can use directly. Aliased to
    // `last_updated` rather than `updated_at` so the projection is not itself a bare
    // read of the column — see test/unit/updated-at-coalesced.test.ts.
    const entries = entryRows.map(r => ({
      id: r.id,
      content: r.content,
      tags: JSON.parse(r.tags ?? "[]"),
      source: r.source,
      created_at: r.created_at,
      updated_at: r.last_updated ?? r.created_at,
      recall_count: r.recall_count ?? 0,
      importance_score: r.importance_score ?? 0,
      contradiction_wins: r.contradiction_wins ?? 0,
      contradiction_losses: r.contradiction_losses ?? 0,
    }));
    const edges = edgeRows.map(r => ({
      source_id: r.source_id,
      target_id: r.target_id,
      type: r.type,
      weight: r.weight,
      provenance: r.provenance,
      created_at: r.created_at,
    }));
    // Like entries and edges, no workspace_id: a restore lands in the caller's own workspace.
    const projects = projectRowsOf(projectRows).map(({ workspace_id: _workspace, ...project }) => project);
    return json({ ok: true, exported_at: Date.now(), version: 3, entries, edges, projects });
  }

  // POST /import — round-trip counterpart to GET /export (issue #217). Inserts by
  // export id (skip if exists), preserves created_at/updated_at/tags/source, defers
  // embedding via vector_ids=[] so POST /vectorize-pending can backfill without
  // burning the Workers AI quota in one request. Does NOT go through /capture.
  //
  // Paged positionally: one call examines entries[offset .. offset+limit), then —
  // once entries are exhausted — edges[edge_offset .. edge_offset+limit) and
  // projects[project_offset .. project_offset+limit). Clients resend the same file
  // with the next_offset/next_edge_offset/next_project_offset from the previous
  // response until all three remaining counts are 0. See importExportPayload for why
  // this is what keeps a large restore inside this codebase's self-imposed D1
  // query budget (well under the platform's real per-invocation ceiling).
  if (url.pathname === "/import" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    // Awaited, not left to ensureDbReady's waitUntil: an import is often a freshly
    // deployed brain's first request, which is exactly when the schema ALTERs have
    // not run yet and every insert would fail on a missing column. Latched after
    // the first call, so this costs nothing in the steady state.
    await initializeDatabase(env);

    let body: unknown;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

    const parsed = parseImportBody(body);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

    const limit = parseImportLimit(url.searchParams.get("limit"));
    const offset = parseImportOffset(url.searchParams.get("offset"));
    const edgeOffset = parseImportOffset(url.searchParams.get("edge_offset"));
    const projectOffset = parseImportOffset(url.searchParams.get("project_offset"));
    // Import always lands in the caller's own personal workspace, never the
    // company layer: a restore is not a share, and the company layer is only
    // ever reached through POST /share ("move, not copy").
    const writeCtx = { workspaceId: auth.personalWorkspaceId, actorId: auth.userId };
    const summary = await importExportPayload(env, parsed.payload, { limit, offset, edgeOffset, projectOffset, writeCtx });
    return json(summary);
  }

  // POST /forget — delete-by-id, mirrors the MCP `forget` tool
  if (url.pathname === "/forget" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);

    const id = body.id.trim();
    const row = await getReadableEntry(env, auth, id);
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    const denied = assertCanMutateEntry(auth, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);

    const result = await forgetEntry(id, env);

    if (result.status === "not_found") {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }

    auditEvent(env, ctx, { entryId: id, actorId: auth.userId, event: "deleted", payload: { deletedVectors: result.vectorCount } });
    return json({ ok: true, id, deletedVectors: result.vectorCount });
  }

  // GET /entry — one full row by id, for the dashboard graph view's tap-to-open
  // (/graph ships 80-char labels only; fattening it with full content would bloat
  // every graph load to serve a per-tap need). Dashboard-only, no MCP twin.
  if (url.pathname === "/entry" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const id = url.searchParams.get("id")?.trim();
    if (!id) return json({ ok: false, error: "id is required" }, 400);

    // Everything the brain knows about one memory, in the one row read it was
    // already doing. The dashboard's detail view shows what the pipeline
    // decided — importance, how often this was recalled, whether it has ever
    // lost a contradiction — and none of it was reachable before v2.3.
    // Scoped like the list above it: an id outside the caller's readable set
    // reads as a missing entry rather than someone else's memory.
    const scope = scopeWhere(auth);
    const row = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at, COALESCE(updated_at, created_at) AS last_updated,
              importance_score, recall_count, contradiction_wins, contradiction_losses, vector_ids,
              workspace_id, actor_id, when_at, when_kind, when_source
       FROM entries WHERE id = ? AND ${scope.clause}`
    ).bind(id, ...scope.bindings).first() as Record<string, any> | null;
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);

    let vectorIds: unknown[] = [];
    try { vectorIds = JSON.parse(row.vector_ids ?? "[]"); } catch { vectorIds = []; }

    const { results: eventRows } = await env.DB.prepare(
      `SELECT actor_id, event, payload, created_at FROM entry_events WHERE entry_id = ? ORDER BY created_at ASC`,
    ).bind(id).all<{ actor_id: string; event: string; payload: string; created_at: number }>();

    const actorIds = [
      String(row.actor_id ?? ""),
      ...(eventRows ?? []).map((e) => e.actor_id),
    ];
    const labelMap = await lookupActorLabels(env, actorIds);
    const layer = layerOf(auth, row.workspace_id);
    const actorName = resolveActorLabel(String(row.actor_id ?? ""), labelMap, {
      viewerId: auth.userId,
      source: row.source as string,
    });
    const timeline = (eventRows ?? []).map((e) => ({
      event: e.event,
      created_at: e.created_at,
      actor_name: resolveActorLabel(e.actor_id, labelMap, { viewerId: auth.userId }),
      payload: (() => { try { return JSON.parse(e.payload ?? "{}"); } catch { return {}; } })(),
    }));

    return json({
      ok: true,
      entry: {
        id: row.id,
        content: row.content,
        tags: JSON.parse(row.tags ?? "[]"),
        source: row.source,
        created_at: row.created_at,
        updated_at: row.last_updated ?? row.created_at,
        importance_score: row.importance_score ?? 0,
        recall_count: row.recall_count ?? 0,
        contradiction_wins: row.contradiction_wins ?? 0,
        contradiction_losses: row.contradiction_losses ?? 0,
        // Whether recall can see it at all — the dashboard already surfaces
        // "not indexed" in lists, and the detail view should agree.
        indexed: Array.isArray(vectorIds) && vectorIds.length > 0,
        when_at: row.when_at ?? null,
        when_kind: row.when_kind ?? null,
        when_source: row.when_source ?? null,
        workspace: layer,
        actor_name: actorName,
        // Whether this caller may edit or forget it, answered by the very
        // predicate the mutation routes enforce with — so the dashboard stops
        // offering an action it will be refused for. One flag rather than two
        // because the server checks edit and delete through the same guard
        // (assertCanEditContent is a re-export of assertCanMutateEntry), and two
        // flags that can never disagree are one flag. Both columns are already
        // in the SELECT above: no extra query.
        can_edit: assertCanMutateEntry(auth, {
          workspace_id: String(row.workspace_id ?? ""),
          actor_id: String(row.actor_id ?? ""),
        }) === null,
        timeline,
      },
    });
  }

  // POST /share — move an entry between the caller's personal and the company
  // workspace (the two-layer visibility model). MOVE semantics: one canonical
  // row, edges follow it, audited. Mirrors the MCP `share` tool.
  if (url.pathname === "/share" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; workspace?: string; team?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (body.workspace !== undefined && body.workspace !== "personal" && body.workspace !== "company") {
      return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
    }
    const target = (body.workspace ?? "company") as ShareTarget;
    const teamRead = readTeamParam(body.team, auth, target);
    if (teamRead.error) return json({ ok: false, error: teamRead.error }, 400);

    const id = body.id.trim();
    const result = await moveEntry(id, target, env, auth, teamRead.teamId);

    if (result.status === "not_found") {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }
    if (result.status === "forbidden") {
      return json({ ok: false, error: "Only the entry's author or an admin can un-share it" }, 403);
    }
    if (result.status === "no_change") {
      return json({ ok: true, id, status: "no_change" });
    }

    auditEvent(env, ctx, {
      entryId: id,
      actorId: auth.userId,
      event: result.status,
      payload: { workspaceId: result.workspaceId },
    });
    // After the audit event, before the response: the D1 move and the audit
    // row are both already committed, so a Vectorize outage here can only
    // cost this cosmetic ranking follow-up, never the state change itself.
    ctx.waitUntil(restampVectorWorkspace(env, result.vectorIds, result.workspaceId));
    return json({ ok: true, id, status: result.status, workspaceId: result.workspaceId });
  }

  // POST /status — set lifecycle status, mirrors the MCP `set_status` tool
  if (url.pathname === "/status" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; status?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (!(STATUS_VALUES as readonly string[]).includes(body.status ?? "")) {
      return json({ ok: false, error: `status must be one of: ${STATUS_VALUES.join(", ")}` }, 400);
    }

    const id = body.id.trim();
    const status = body.status as MemoryStatus;
    const row = await getReadableEntry(env, auth, id);
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    const denied = assertCanMutateEntry(auth, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);

    const ok = await applyStatus(id, status, env);

    if (!ok) {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }

    auditEvent(env, ctx, { entryId: id, actorId: auth.userId, event: "status_changed", payload: { status } });
    return json({ ok: true, id, status });
  }

  return null;
}
