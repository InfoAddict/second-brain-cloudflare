import { validInputTags, projectSlugError, projectTagError, withProjectTag, MAX_INPUT_TAGS, MAX_INPUT_TAG_CHARS, reservedTagsNote, stripNewReservedTags } from "../tags/system";
import { autoCreateProject } from "../projects/autocreate";
import type { Env } from "../env";
import { resolveConfig, type Config } from "../config";
import { VECTORIZE_FIX_HINT } from "../constants";
import { json } from "../lib/http";
import { requireIdentity, type Identity } from "../lib/identity";
import { assertCanEditContent, getReadableEntry } from "../lib/entry-access";
import { scopeWrite, effectiveWriteTarget, readTeamParam, type WriteContext } from "../lib/scope";
import { captureEntry } from "../capture/entry";
import { appendToEntry, EntryGoneError, updateEntryContent, WriteConflictError } from "../capture/store";
import { isManagedMirror, mirrorEditError } from "../integrations/mirror";
import { auditEvent } from "../lib/audit";
import { VOLATILITY_VALUES, withVolatility, type Volatility } from "../memory/volatility";
import { parseExplicitWhen } from "../when/input";
import { contentByteLength, isOverContentLimit, tooLargeRestBody, MAX_CONTENT_BYTES } from "../lib/content-size";
import { parseValidityInput, updateEntryValidity, VALIDITY_WITH_CONTENT_ERROR, type UpdateValidityResult } from "../memory/validity";

/** Validate route-only volatility input; MCP gets equivalent Zod validation. */
/** Where this caller's writes land and who gets stamped on them. */
export async function writeContextFor(
  env: Env,
  identity: Identity,
  target?: unknown,
  team?: unknown,
): Promise<WriteContext | Response> {
  const orgDefault = (await resolveConfig(env)).TEAM_DEFAULT_WORKSPACE;
  const resolvedTarget = effectiveWriteTarget(identity, target, orgDefault);
  const teamRead = readTeamParam(team, identity, resolvedTarget);
  if (teamRead.error) return json({ ok: false, error: teamRead.error }, 400);
  return {
    workspaceId: scopeWrite(identity, resolvedTarget, teamRead.teamId),
    actorId: identity.userId,
  };
}

function readVolatility(raw: unknown): { value?: Volatility; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string" || !(VOLATILITY_VALUES as readonly string[]).includes(raw)) {
    return { error: `volatility must be one of: ${VOLATILITY_VALUES.join(", ")}` };
  }
  return { value: raw as Volatility };
}

/**
 * Additive: older clients ignore both extra fields. Merged rather than
 * overwritten, since several branches already carry their own `message`.
 */
function withReservedNote(body: Record<string, unknown>, ignored: readonly string[]): Record<string, unknown> {
  if (!ignored.length) return body;
  const note = reservedTagsNote(ignored);
  const existingMessage = typeof body.message === "string" ? body.message : undefined;
  return { ...body, ignored_tags: [...ignored], message: existingMessage ? `${existingMessage} ${note}` : note };
}

export async function handleCaptureRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // POST /capture
  if (url.pathname === "/capture" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    let body: { content?: string; tags?: string[]; source?: string; volatility?: unknown; workspace?: unknown; team?: unknown; project?: unknown; when?: unknown; when_kind?: unknown; valid_from?: unknown; valid_until?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (body.tags !== undefined && !validInputTags(body.tags)) return json({ ok: false, error: `tags must contain at most ${MAX_INPUT_TAGS} NUL-free strings of at most ${MAX_INPUT_TAG_CHARS} characters` }, 400);
    const badProjectTag = body.tags === undefined ? null : projectTagError(body.tags);
    if (badProjectTag) return json({ ok: false, error: badProjectTag }, 400);
    if (typeof body.content === "string" && body.content.includes("\0")) return json({ ok: false, error: "NUL is not allowed" }, 400);
    if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);
    // Rahil's decision (18-copy-deck.md 6.8): 128 KB per note, so a very large paste cannot
    // spend the Worker's 10 ms CPU budget on one write. Checked before anything is written.
    if (isOverContentLimit(body.content)) return json(tooLargeRestBody(), 413);
    if (body.workspace !== undefined && body.workspace !== "personal" && body.workspace !== "company") {
      return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
    }

    const captureVol = readVolatility(body.volatility);
    if (captureVol.error) return json({ ok: false, error: captureVol.error }, 400);

    let when: { at: number; kind: "due" | "event" | "wake"; source: "explicit" } | undefined;
    if (body.when !== undefined && body.when !== null) {
      if (typeof body.when !== "string") return json({ ok: false, error: "when must be a string" }, 400);
      const parsed = parseExplicitWhen(body.when, body.when_kind, undefined, (await resolveConfig(env)).TIMEZONE);
      if (parsed.error) return json({ ok: false, error: parsed.error }, 400);
      when = parsed.value;
    } else if (body.when_kind !== undefined) {
      return json({ ok: false, error: "when_kind requires when" }, 400);
    }

    // T-0089.2.1: when the fact became and stopped being true, as the user said it.
    const validity = parseValidityInput(body, Date.now(), (await resolveConfig(env)).TIMEZONE, { allowNull: false });
    if ("error" in validity) return json({ ok: false, error: validity.error, field: validity.field }, 400);

    // Empty means absent, like every other optional param. A bad slug is bad input, not an
    // unknown project, so it fails the capture before anything is written.
    let projectSlug: string | undefined;
    if (body.project !== undefined && body.project !== null && body.project !== "") {
      if (typeof body.project !== "string") return json({ ok: false, error: "project must be a string" }, 400);
      projectSlug = body.project.trim();
      const badSlug = projectSlugError(projectSlug);
      if (badSlug) return json({ ok: false, error: badSlug }, 400);
    }

    const volatileTags = captureVol.value
      ? withVolatility(body.tags ?? [], captureVol.value)
      : body.tags ?? [];
    const captureTags = projectSlug ? withProjectTag(volatileTags, projectSlug) : volatileTags;
    // MAX_INPUT_TAGS bounds the caller's own tags (checked above). The project: and
    // volatility: tags the Worker adds may take a capture past it; refusing a capture
    // over a convenience tag would lose the memory.

    // Computed on the caller's raw tags — captureEntry strips these again on its own
    // path (normalizeCaptureInput), this is purely for telling the caller honestly.
    const { ignored: ignoredReservedTags } = stripNewReservedTags(body.tags ?? []);

    const writeCtx = await writeContextFor(env, identity, body.workspace, body.team);
    if (writeCtx instanceof Response) return writeCtx;

    const result = await captureEntry(body.content, captureTags, body.source ?? "api", env, ctx, undefined, writeCtx, when, { channel: "rest", validity: validity.value });

    if (projectSlug && result.status !== "blocked") {
      await autoCreateProject(env, ctx, { workspaceId: writeCtx.workspaceId, actorId: identity.userId, slug: projectSlug });
    }

    if (result.status !== "blocked") {
      // Audit at the edge where identity and ctx both live; the domain layer
      // stays free of request state. "stored"/"flagged" are creations, the
      // rest are rewrites of an existing row.
      auditEvent(env, ctx, {
        entryId: result.id,
        actorId: identity.userId,
        event: result.status === "stored" || result.status === "flagged" ? "created" : "updated",
        payload: { captureStatus: result.status, channel: "rest" },
      });
    }

    if (result.status === "blocked") {
      return json({
        ok: false,
        duplicate: true,
        matchId: result.matchId,
        score: parseFloat((result.score * 100).toFixed(1)),
        message: "Near-exact duplicate detected — not stored",
      });
    }
    if (result.status === "contradiction") {
      const supersede = result.supersede
        ? { closed_id: result.supersede.closedId, at: result.supersede.at, direction: result.supersede.direction }
        : null;
      return json(withReservedNote({ ok: true, id: result.id, resolved_conflict: result.resolvedConflict, reason: result.reason, supersede }, ignoredReservedTags));
    }
    if (result.status === "contradiction_protected") {
      return json(withReservedNote({
        ok: true,
        id: result.id,
        status: result.entryStatus,
        kept_canonical: result.canonicalId,
        reason: result.reason,
      }, ignoredReservedTags));
    }
    if (result.status === "replaced") {
      return json(withReservedNote({ ok: true, id: result.id, action: "replaced", message: "New memory replaced an outdated existing entry" }, ignoredReservedTags));
    }
    if (result.status === "merged") {
      return json(withReservedNote({ ok: true, id: result.id, action: "merged", message: "Memories merged into a single combined entry" }, ignoredReservedTags));
    }
    if (result.status === "flagged") {
      return json(withReservedNote({
        ok: true,
        id: result.id,
        warning: "similar",
        matchId: result.matchId,
        score: parseFloat((result.score * 100).toFixed(1)),
        message: "Stored but similar entry exists — tagged as duplicate-candidate",
      }, ignoredReservedTags));
    }
    // Additive: older clients ignore the extra field, and the dashboard uses it
    // to show what was filed under what.
    return json(withReservedNote({ ok: true, id: result.id, tags: result.tags ?? [] }, ignoredReservedTags));
  }

  // POST /append
  if (url.pathname === "/append" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    let body: { id?: string; addition?: string; volatility?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (typeof body.addition === "string" && body.addition.includes("\0")) return json({ ok: false, error: "NUL is not allowed" }, 400);
    if (!body.addition?.trim()) return json({ ok: false, error: "addition is required" }, 400);

    const appendVol = readVolatility(body.volatility);
    if (appendVol.error) return json({ ok: false, error: appendVol.error }, 400);

    const id = body.id.trim();
    const addition = body.addition.trim();

    const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, content, tags, source");
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    const denied = assertCanEditContent(identity, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);

    const existingContent = row.content as string;
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    const source = row.source as string;

    if (await isManagedMirror(source, env)) {
      return json({ ok: false, error: mirrorEditError(source) }, 409);
    }

    // Rahil's decision (18-copy-deck.md 6.8): checks the RESULTING total, not the addition
    // alone — an append that would push an already-large memory over 128 KB is refused before
    // anything is written, same as a fresh capture or a full replacement.
    if (contentByteLength(existingContent) + contentByteLength(addition) > MAX_CONTENT_BYTES) {
      return json(tooLargeRestBody(), 413);
    }

    let indexed: boolean;
    try {
      const writeCtx = await writeContextFor(env, identity);
      if (writeCtx instanceof Response) return writeCtx;
      indexed = await appendToEntry(env, id, existingContent, addition, tags, source, await resolveConfig(env), appendVol.value, writeCtx, { actorId: identity.userId, channel: "rest" }, undefined, row.workspace_id as string);
    } catch (e) {
      if (e instanceof WriteConflictError) return json({ ok: false, error: "Entry changed while saving, try again" }, 409);
      if (e instanceof EntryGoneError) return json({ ok: false, error: e.message }, 404);
      return json({ ok: false, error: `Append failed: ${(e as Error).message}` }, 500);
    }

    auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "appended", payload: { channel: "rest" } });

    return json({
      ok: true,
      id,
      semantic_unavailable: !indexed,
      message: indexed
        ? "Update appended successfully with timestamp"
        : `Update appended, but not indexed for semantic search (Vectorize unavailable) — it is still findable by keyword. Fix: ${VECTORIZE_FIX_HINT}.`,
    });
  }

  // POST /update
  if (url.pathname === "/update" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    let body: { id?: string; content?: string; volatility?: unknown; tags?: unknown; valid_from?: unknown; valid_until?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);

    // T-0089.2.1: valid_from / valid_until, the same rules as the MCP update tool.
    const hasValidity = body.valid_from !== undefined || body.valid_until !== undefined;
    if (body.content === undefined && !hasValidity) return json({ ok: false, error: "Nothing to update: pass content, valid_from or valid_until." }, 400);
    if (body.content === undefined && (body.tags !== undefined || body.volatility !== undefined)) return json({ ok: false, error: "To change tags or volatility, pass content too." }, 400);
    if (body.content !== undefined && body.valid_from !== undefined) return json({ ok: false, error: VALIDITY_WITH_CONTENT_ERROR, field: "valid_from" }, 400);
    const validityCfg = hasValidity ? await resolveConfig(env) : null;
    const validity = hasValidity ? parseValidityInput(body, Date.now(), (validityCfg as Config).TIMEZONE, { allowNull: true }) : null;
    if (validity && "error" in validity) return json({ ok: false, error: validity.error, field: validity.field }, 400);
    const setValidity = (workspaceId: string) =>
      updateEntryValidity(env, body.id!.trim(), validity!.value as { from?: number | null; until?: number | null }, { actorId: identity.userId, channel: "rest" }, validityCfg as Config, workspaceId);
    const validityBody = (r: UpdateValidityResult): { status: number; body: Record<string, unknown> } => {
      if (r.status === "updated") return { status: 200, body: { validity: { valid_from: r.effectiveFrom, valid_from_stated: r.validFrom !== null, valid_until: r.validUntil, propagated: r.propagated } } };
      if (r.status === "refused") return { status: 400, body: { ok: false, error: r.error, field: r.field } };
      if (r.status === "no_change") return { status: 200, body: { validity: null, changed: false } };
      if (r.status === "conflict") return { status: 409, body: { ok: false, error: "Entry changed while saving, try again" } };
      return { status: 404, body: { ok: false, error: `No entry found with ID: ${body.id!.trim()}` } };
    };
    if (body.content === undefined) {
      const target = await getReadableEntry(env, identity, body.id.trim(), "id, workspace_id, actor_id");
      if (!target) return json({ ok: false, error: `No entry found with ID: ${body.id.trim()}` }, 404);
      const refused = assertCanEditContent(identity, target);
      if (refused) return json({ ok: false, error: refused.message }, 403);
      const out = validityBody(await setValidity(target.workspace_id as string));
      return json(out.status === 200 ? { ok: true, id: body.id.trim(), ...out.body } : out.body, out.status);
    }
    if (body.tags !== undefined && !validInputTags(body.tags)) return json({ ok: false, error: `tags must contain at most ${MAX_INPUT_TAGS} NUL-free strings of at most ${MAX_INPUT_TAG_CHARS} characters` }, 400);
    const badProjectTag = body.tags === undefined ? null : projectTagError(body.tags);
    if (badProjectTag) return json({ ok: false, error: badProjectTag }, 400);
    if (typeof body.content === "string" && body.content.includes("\0")) return json({ ok: false, error: "NUL is not allowed" }, 400);
    if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);
    // Rahil's decision (18-copy-deck.md 6.8): 128 KB per note, checked before anything is written.
    if (isOverContentLimit(body.content)) return json(tooLargeRestBody(), 413);

    const updateVol = readVolatility(body.volatility);
    if (updateVol.error) return json({ ok: false, error: updateVol.error }, 400);

    // Absent means "leave the tags alone" — every client but the editor omits the
    // key, and reading a missing key as an empty list would have them all wiping
    // tags on save. An explicit [] does mean the user removed the last one.
    let replaceTags: string[] | undefined;
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.some(t => typeof t !== "string")) {
        return json({ ok: false, error: "tags must be an array of strings" }, 400);
      }
      replaceTags = body.tags as string[];
    }

    const id = body.id.trim();
    const newContent = body.content.trim();

    // Refuse before anything is written. Only `source` is needed: updateEntryContent reads
    // the rest for itself, and keeping the mirror guard out here is what stops
    // capture/store.ts having to depend on the integrations registry (see #289).
    const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, source");
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    const denied = assertCanEditContent(identity, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);

    if (await isManagedMirror(row.source as string, env)) {
      return json({ ok: false, error: mirrorEditError(row.source as string) }, 409);
    }

    const writeCtx = await writeContextFor(env, identity);
    if (writeCtx instanceof Response) return writeCtx;

    // Computed on the caller's raw tags — updateEntryContent strips these again on its
    // own path (applyTagReplacement), this is purely for telling the caller honestly.
    // Absent (undefined) means "leave the tags alone", so nothing was ignored.
    const { ignored: ignoredReservedTags } = stripNewReservedTags(replaceTags ?? []);

    const result = await updateEntryContent(env, id, newContent, await resolveConfig(env), updateVol.value, replaceTags, writeCtx, { actorId: identity.userId, channel: "rest" }, row.workspace_id as string);

    // Only reachable if the entry was deleted between the guard read and the write.
    if (result.status === "not_found") {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }

    // R2-5: the row is still there, just moved out of this caller's reach mid-edit — a conflict to
    // retry, not a memory that vanished.
    if (result.status === "moved") {
      return json({ ok: false, error: "Entry changed while saving, try again" }, 409);
    }

    if (result.status === "reembed_failed") {
      return json({ ok: false, error: "Couldn't update: search re-index failed. Your memory is unchanged — please try again." }, 500);
    }

    if (result.status === "conflict") {
      return json({ ok: false, error: "Entry changed while saving, try again" }, 409);
    }

    // Only a write that happened is audited.
    auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "updated", payload: { channel: "rest" } });
    // New content plus an end date: the text first, then the window, each its own version.
    const endFields = hasValidity ? validityBody(await setValidity(row.workspace_id as string)).body : {};

    if (!result.vectorIds) {
      return json(withReservedNote({
        ...endFields,
        ok: true,
        id,
        vectors: 0,
        semantic_unavailable: true,
        message: `Updated, but not re-indexed for semantic search (Vectorize unavailable) — the previous index is kept and it is still findable by keyword. Fix: ${VECTORIZE_FIX_HINT}.`,
      }, ignoredReservedTags));
    }

    return json(withReservedNote({ ...endFields, ok: true, id, vectors: result.vectorIds.length }, ignoredReservedTags));
  }

  return null;
}
