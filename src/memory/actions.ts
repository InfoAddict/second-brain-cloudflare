import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { getReadableEntry, assertCanEditContent } from "../lib/entry-access";
import { auditEvent, auditEvents, type AuditEventInput } from "../lib/audit";
import { withTaskDone, withoutTask } from "./loops";
import { hasStaleAsOf, withoutStaleAsOf } from "./stale";
import { parseTags } from "../insight/candidates";
import { parseExplicitWhen } from "../when/input";
import { resolveConfig } from "../config";
import { withStatus, getStatus } from "./status";
import { withKind } from "./kind";
import { deleteVectorIds } from "../vectorize/batch";

export type ResolveAction = "done" | "not_a_task" | "snooze" | "clear_date" | "still_true";
export type ActionResult = { ok: true; id: string; action: ResolveAction; when_at?: number } | { ok: false; error: string; status: number };

type AuditContext = { waitUntil(promise: Promise<unknown>): void };
const channelPayload = (channel?: "mcp") => channel ? { channel } : {};

/** The REST routes and MCP resolve tool use this same read, guard, write and audit path. */
export async function resolveEntryAction(
  env: Env, ctx: AuditContext, identity: Identity, id: string,
  action: ResolveAction, untilInput?: string, channel?: "mcp",
): Promise<ActionResult> {
  let until: number | undefined;
  if (action === "snooze") {
    if (!untilInput?.trim()) return { ok: false, error: "until is required", status: 400 };
    const parsed = parseExplicitWhen(untilInput, undefined, undefined, (await resolveConfig(env)).TIMEZONE);
    if (parsed.error) return { ok: false, error: parsed.error, status: 400 };
    until = parsed.value!.at;
    if (until <= Date.now()) return { ok: false, error: "until must be in the future", status: 400 };
  }
  if (action === "still_true") {
    const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, tags");
    if (!row) return { ok: false, error: `No entry found with ID: ${id}`, status: 404 };
    const denied = assertCanEditContent(identity, row);
    if (denied) return { ok: false, error: denied.message, status: 403 };
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    if (!hasStaleAsOf(tags)) return { ok: false, error: "Entry is not flagged as out of date", status: 400 };
    const now = Date.now();
    await env.DB.prepare(`UPDATE entries SET tags = ?, updated_at = ?, staleness_checked_at = ? WHERE id = ?`)
      .bind(JSON.stringify(withoutStaleAsOf(tags)), now, now, id).run();
    auditEvents(env, ctx, [{ entryId: id, actorId: identity.userId, event: "updated", payload: { stale_confirmed: true, ...channelPayload(channel) } }]);
    return { ok: true, id, action };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, tags, content");
    if (!row) return { ok: false, error: `No entry found with ID: ${id}`, status: 404 };
    const denied = assertCanEditContent(identity, row);
    if (denied) return { ok: false, error: denied.message, status: 403 };
    const tags = parseTags(row.tags as string);
    let statement: D1PreparedStatement;
    let payload: Record<string, unknown>;
    if (action === "done" || action === "not_a_task") {
      const nextTags = action === "done" ? withTaskDone(tags) : withoutTask(tags);
      statement = env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ? AND tags = ? AND content = ?`)
        .bind(JSON.stringify(nextTags), id, row.tags, row.content);
      payload = { loop_action: action === "done" ? "done" : "not-task" };
    } else if (action === "snooze") {
      statement = env.DB.prepare(`UPDATE entries SET when_at = ? WHERE id = ? AND tags = ? AND content = ?`)
        .bind(until, id, row.tags, row.content);
      payload = { due_action: "snooze", until };
    } else {
      statement = env.DB.prepare(`UPDATE entries SET when_at = NULL, when_kind = NULL, when_label = NULL, when_source = 'cleared' WHERE id = ? AND tags = ? AND content = ?`)
        .bind(id, row.tags, row.content);
      payload = { due_action: "clear" };
    }
    const result = await statement.run();
    if ((result.meta.changes ?? result.meta.rows_written ?? 0) > 0) {
      auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "status_changed", payload: { ...payload, ...channelPayload(channel) } });
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
  env: Env, ctx: AuditContext, actorId: string,
  found: Record<string, any>[], requestedCount: number, action: InsightAction, channel?: "mcp",
): Promise<InsightResolution> {
  const statements: D1PreparedStatement[] = [];
  const vectorsToDrop: string[] = [];
  const resolved: string[] = [];
  const auditRows: AuditEventInput[] = [];
  for (const row of found) {
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    if (!tags.includes("auto-insight") || getStatus(tags) === "deprecated") continue;
    if (action === "confirm") {
      const promoted = withStatus(withKind(tags.filter(t => t !== "auto-insight"), "semantic"), "canonical");
      statements.push(env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(promoted), row.id));
    } else {
      statements.push(env.DB.prepare(`UPDATE entries SET tags = ?, vector_ids = ? WHERE id = ?`)
        .bind(JSON.stringify(withStatus(tags, "deprecated")), "[]", row.id));
      vectorsToDrop.push(...(JSON.parse(row.vector_ids ?? "[]") as string[]));
    }
    resolved.push(row.id as string);
    auditRows.push({ entryId: row.id as string, actorId, event: action === "confirm" ? "insight_confirmed" : "insight_dismissed", ...(channel ? { payload: { channel } } : {}) });
  }
  if (statements.length) await env.DB.batch(statements);
  auditEvents(env, ctx, auditRows);
  if (vectorsToDrop.length) {
    try { await deleteVectorIds(env, vectorsToDrop); }
    catch (e) { console.error("Vectorize deleteByIds failed during bulk dismiss (non-fatal):", e); }
  }
  return { resolved, skipped: requestedCount - resolved.length };
}
