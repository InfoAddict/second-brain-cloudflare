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
import { changesOf, pruneManyStatement, pruneStatement, snapshotManyStatement, snapshotStatement, type WhenChange } from "./versions";

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
    // The date columns join the CAS so the recorded prior is the value actually replaced.
    const whenUnchanged = `AND when_at IS ? AND when_kind IS ? AND when_label IS ? AND when_source IS ?`;
    const whenBindings = [priorWhen.when_at, priorWhen.when_kind, priorWhen.when_label, priorWhen.when_source];
    const now = Date.now();
    let statement: D1PreparedStatement;
    let payload: Record<string, unknown>;
    let snapshot: D1PreparedStatement;
    if (action === "done" || action === "not_a_task") {
      const nextTags = action === "done" ? withTaskDone(tags) : withoutTask(tags);
      snapshot = snapshotStatement(env, {
        entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags, meta: { loop_action: action === "done" ? "done" : "not-task" }, now,
        guard: p => `e.tags = ${p.add(row.tags)} AND e.content = ${p.add(row.content)}`,
      });
      // versioning: snapshot
      statement = env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ? AND tags = ? AND content = ?`)
        .bind(JSON.stringify(nextTags), id, row.tags, row.content);
      payload = { loop_action: action === "done" ? "done" : "not-task", prior: { tags } };
    } else if (action === "snooze") {
      const nextWhen: WhenChange = { when_at: until };
      snapshot = snapshotStatement(env, {
        entryId: id, reason: "due", change, content: { kind: "unchanged" }, nextTags: tags, nextWhen, meta: { due_action: "snooze", until }, now,
        guard: p => `e.tags = ${p.add(row.tags)} AND e.content = ${p.add(row.content)}`,
      });
      // versioning: snapshot
      statement = env.DB.prepare(`UPDATE entries SET when_at = ? WHERE id = ? AND tags = ? AND content = ? ${whenUnchanged}`)
        .bind(until, id, row.tags, row.content, ...whenBindings);
      payload = { due_action: "snooze", until, prior: priorWhen };
    } else {
      const nextWhen: WhenChange = { when_at: null, when_kind: null, when_source: "cleared", when_label: null };
      snapshot = snapshotStatement(env, {
        entryId: id, reason: "due", change, content: { kind: "unchanged" }, nextTags: tags, nextWhen, meta: { due_action: "clear" }, now,
        guard: p => `e.tags = ${p.add(row.tags)} AND e.content = ${p.add(row.content)}`,
      });
      // versioning: snapshot
      statement = env.DB.prepare(`UPDATE entries SET when_at = NULL, when_kind = NULL, when_label = NULL, when_source = 'cleared' WHERE id = ? AND tags = ? AND content = ? ${whenUnchanged}`)
        .bind(id, row.tags, row.content, ...whenBindings);
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
