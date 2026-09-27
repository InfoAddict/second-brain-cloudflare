import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { getReadableEntry, assertCanEditContent, type EntryAccessRow } from "../lib/entry-access";
import { auditEvent, auditEvents, type AuditEventInput, type ChangeContext } from "../lib/audit";
import { withTaskDone, withoutTask } from "./loops";
import { hasStaleAsOf, withoutStaleAsOf } from "./stale";
import { parseTags } from "../insight/candidates";
import { parseExplicitWhen } from "../when/input";
import { resolveConfig } from "../config";
import { withStatus, getStatus } from "./status";
import { withKind } from "./kind";
import { deleteVectorIds } from "../vectorize/batch";
import { buildCasGuard, changesOf, Params, pruneManyStatement, pruneStatement, snapshotManyStatement, snapshotStatement, type WhenChange } from "./versions";

export type ResolveAction = "done" | "not_a_task" | "snooze" | "clear_date" | "still_true";
export type ActionResult = { ok: true; id: string; action: ResolveAction; when_at?: number } | { ok: false; error: string; status: number };

type AuditContext = { waitUntil(promise: Promise<unknown>): void };
const channelPayload = (change: ChangeContext) => ({ channel: change.channel });

/** The REST routes and MCP resolve tool use this same read, guard, write and audit path. */
export async function resolveEntryAction(
  env: Env, ctx: AuditContext, identity: Identity, id: string,
  action: ResolveAction, untilInput: string | undefined, change: ChangeContext,
): Promise<ActionResult> {
  const cfg = await resolveConfig(env);
  let until: number | undefined;
  if (action === "snooze") {
    if (!untilInput?.trim()) return { ok: false, error: "until is required", status: 400 };
    const parsed = parseExplicitWhen(untilInput, undefined, undefined, cfg.TIMEZONE);
    if (parsed.error) return { ok: false, error: parsed.error, status: 400 };
    until = parsed.value!.at;
    if (until <= Date.now()) return { ok: false, error: "until must be in the future", status: 400 };
  }
  if (action === "still_true") {
    const row = await getReadableEntry(env, identity, id, `id, workspace_id, actor_id, tags, COALESCE(updated_at, created_at) AS prior_updated_at, staleness_checked_at`) as (EntryAccessRow & Record<string, any> | null);
    if (!row) return { ok: false, error: `No entry found with ID: ${id}`, status: 404 };
    const denied = assertCanEditContent(identity, row);
    if (denied) return { ok: false, error: denied.message, status: 403 };
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    if (!hasStaleAsOf(tags)) return { ok: false, error: "Entry is not flagged as out of date", status: 400 };
    const now = Date.now();
    const nextTags = withoutStaleAsOf(tags);
    await env.DB.batch([
      snapshotStatement(env, { entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags, meta: { stale_confirmed: true }, now }),
      // versioning: snapshot
      env.DB.prepare(`UPDATE entries SET tags = ?, updated_at = ?, staleness_checked_at = ? WHERE id = ?`)
        .bind(JSON.stringify(nextTags), now, now, id),
      pruneStatement(env, id, cfg.VERSION_KEEP),
    ]);
    auditEvents(env, ctx, [{ entryId: id, actorId: identity.userId, event: "updated", payload: {
      stale_confirmed: true,
      prior: { tags, updated_at: row.prior_updated_at, staleness_checked_at: row.staleness_checked_at ?? null },
      ...channelPayload(change),
    } }]);
    return { ok: true, id, action };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, tags, content, when_at, when_kind, when_label, when_source") as (EntryAccessRow & Record<string, any> | null);
    if (!row) return { ok: false, error: `No entry found with ID: ${id}`, status: 404 };
    const denied = assertCanEditContent(identity, row);
    if (denied) return { ok: false, error: denied.message, status: 403 };
    const tags = parseTags(row.tags as string);
    const priorWhen = { when_at: row.when_at ?? null, when_kind: row.when_kind ?? null, when_label: row.when_label ?? null, when_source: row.when_source ?? null };
    const now = Date.now();
    let statement: D1PreparedStatement;
    let payload: Record<string, unknown>;
    let snapshot: D1PreparedStatement;
    // The guard is built once and fed to both the snapshot and the UPDATE (spec P3, ADV-1): a
    // hand-written second copy is exactly how the snapshot's guard fell out of step with the
    // UPDATE's own WHERE clause and kept writing versions for changes that never landed. It also
    // pins workspace_id (ADV-2): a row that moved to a workspace this request was never authorized
    // to write into must miss the CAS, not just miss unnoticed — the retry above then re-reads
    // through getReadableEntry, which returns not_found or forbidden once the row is truly gone
    // from this caller's reach, rather than committing into wherever it ended up.
    if (action === "done" || action === "not_a_task") {
      const nextTags = action === "done" ? withTaskDone(tags) : withoutTask(tags);
      const casColumns = { tags: row.tags, content: row.content, workspace_id: row.workspace_id };
      snapshot = snapshotStatement(env, {
        entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags, meta: { loop_action: action === "done" ? "done" : "not-task" }, now,
        guard: p => buildCasGuard(p, casColumns),
      });
      const p = new Params();
      const nextTagsIdx = p.add(JSON.stringify(nextTags));
      // versioning: snapshot
      statement = env.DB.prepare(`UPDATE entries AS e SET tags = ${nextTagsIdx} WHERE e.id = ${p.add(id)} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values());
      payload = { loop_action: action === "done" ? "done" : "not-task", prior: { tags } };
    } else if (action === "snooze") {
      const nextWhen: WhenChange = { when_at: until };
      const casColumns = { tags: row.tags, content: row.content, workspace_id: row.workspace_id, ...priorWhen };
      snapshot = snapshotStatement(env, {
        entryId: id, reason: "due", change, content: { kind: "unchanged" }, nextTags: tags, nextWhen, meta: { due_action: "snooze", until }, now,
        guard: p => buildCasGuard(p, casColumns),
      });
      const p = new Params();
      const untilIdx = p.add(until);
      // versioning: snapshot
      statement = env.DB.prepare(`UPDATE entries AS e SET when_at = ${untilIdx} WHERE e.id = ${p.add(id)} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values());
      payload = { due_action: "snooze", until, prior: priorWhen };
    } else {
      const nextWhen: WhenChange = { when_at: null, when_kind: null, when_source: "cleared", when_label: null };
      const casColumns = { tags: row.tags, content: row.content, workspace_id: row.workspace_id, ...priorWhen };
      snapshot = snapshotStatement(env, {
        entryId: id, reason: "due", change, content: { kind: "unchanged" }, nextTags: tags, nextWhen, meta: { due_action: "clear" }, now,
        guard: p => buildCasGuard(p, casColumns),
      });
      const p = new Params();
      const idIdx = p.add(id);
      // versioning: snapshot
      statement = env.DB.prepare(`UPDATE entries AS e SET when_at = NULL, when_kind = NULL, when_label = NULL, when_source = 'cleared' WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values());
      payload = { due_action: "clear", prior: priorWhen };
    }
    const results = await env.DB.batch([snapshot, statement, pruneStatement(env, id, cfg.VERSION_KEEP)]);
    if (changesOf(results[1]) > 0) {
      auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "status_changed", payload: { ...payload, ...channelPayload(change) } });
      return { ok: true, id, action, ...(action === "snooze" ? { when_at: until } : {}) };
    }
  }
  const verb = action === "snooze" ? "snooze" : action === "clear_date" ? "clear" : "resolve";
  return { ok: false, error: `Could not ${verb} — try again`, status: 409 };
}

export type InsightAction = "confirm" | "dismiss";
export interface InsightResolution { resolved: string[]; skipped: number }

/** Apply already scoped insight rows in one D1 batch, also for the one-id MCP form. */
export async function applyInsightResolution(
  env: Env, ctx: AuditContext, change: ChangeContext,
  found: Record<string, any>[], requestedCount: number, action: InsightAction,
): Promise<InsightResolution> {
  const cfg = await resolveConfig(env);
  const statements: D1PreparedStatement[] = [];
  const vectorsToDrop: string[] = [];
  const resolved: string[] = [];
  const auditRows: AuditEventInput[] = [];
  for (const row of found) {
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    if (!tags.includes("auto-insight") || getStatus(tags) === "deprecated") continue;
    if (action === "confirm") {
      const promoted = withStatus(withKind(tags.filter(t => t !== "auto-insight"), "semantic"), "canonical");
      // versioning: snapshot (via the snapshotManyStatement batched below)
      statements.push(env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(promoted), row.id));
    } else {
      // versioning: snapshot (via the snapshotManyStatement batched below)
      statements.push(env.DB.prepare(`UPDATE entries SET tags = ?, vector_ids = ? WHERE id = ?`)
        .bind(JSON.stringify(withStatus(tags, "deprecated")), "[]", row.id));
      vectorsToDrop.push(...(JSON.parse(row.vector_ids ?? "[]") as string[]));
    }
    resolved.push(row.id as string);
    auditRows.push({ entryId: row.id as string, actorId: change.actorId, event: action === "confirm" ? "insight_confirmed" : "insight_dismissed", payload: { prior: { tags }, ...channelPayload(change) } });
  }
  if (statements.length) {
    const now = Date.now();
    await env.DB.batch([
      snapshotManyStatement(env, { entryIds: resolved, reason: "status", change, content: { kind: "unchanged" }, meta: { insight_action: action }, now }),
      ...statements,
      pruneManyStatement(env, resolved, cfg.VERSION_KEEP),
    ]);
  }
  auditEvents(env, ctx, auditRows);
  if (vectorsToDrop.length) {
    try { await deleteVectorIds(env, vectorsToDrop); }
    catch (e) { console.error("Vectorize deleteByIds failed during bulk dismiss (non-fatal):", e); }
  }
  return { resolved, skipped: requestedCount - resolved.length };
}
