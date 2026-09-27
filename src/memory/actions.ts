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
import { buildCasGuard, changesOf, Params, pruneManyStatement, pruneStatement, snapshotStatement, type WhenChange } from "./versions";

export type ResolveAction = "done" | "not_a_task" | "snooze" | "clear_date" | "still_true";
export type ActionResult = { ok: true; id: string; action: ResolveAction; when_at?: number } | { ok: false; error: string; status: number };

type AuditContext = { waitUntil(promise: Promise<unknown>): void };
/** BE-5/BE-6 (T-0101.5.1/T-0101.5.2): every audit event this file writes carries the same
 * channel-and-client pair a version's own meta does, so the history and trash surfaces can name
 * the client without a special case for resolve/forget/set_status. `client` is spread only when
 * present, so an old event payload's shape (channel alone) is unchanged for REST and system writes. */
const channelPayload = (change: ChangeContext) => ({ channel: change.channel, ...(change.client ? { client: change.client } : {}) });

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
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await getReadableEntry(env, identity, id, `id, workspace_id, actor_id, tags, COALESCE(updated_at, created_at) AS prior_updated_at, staleness_checked_at`) as (EntryAccessRow & Record<string, any> | null);
      if (!row) return { ok: false, error: `No entry found with ID: ${id}`, status: 404 };
      const denied = assertCanEditContent(identity, row);
      if (denied) return { ok: false, error: denied.message, status: 403 };
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      if (!hasStaleAsOf(tags)) return { ok: false, error: "Entry is not flagged as out of date", status: 400 };
      const now = Date.now();
      const nextTags = withoutStaleAsOf(tags);
      // Guarded on tags and workspace_id (buildCasGuard, spec P3, ADV-1/ADV-2): a concurrent edit
      // (a user-edited tag, say) between this read and the write must be kept, not overwritten by a
      // confirm that no longer describes the row as it stands, and a row moved out of this caller's
      // workspace must miss rather than commit there.
      const casColumns = { tags: row.tags, workspace_id: row.workspace_id };
      const p = new Params();
      const tagsIdx = p.add(JSON.stringify(nextTags));
      const nowIdx = p.add(now);
      const idIdx = p.add(id);
      const results = await env.DB.batch([
        snapshotStatement(env, {
          entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags, meta: { stale_confirmed: true }, now,
          guard: p2 => buildCasGuard(p2, casColumns),
        }),
        // versioning: snapshot
        env.DB.prepare(`UPDATE entries AS e SET tags = ${tagsIdx}, updated_at = ${nowIdx}, staleness_checked_at = ${nowIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`)
          .bind(...p.values()),
        pruneStatement(env, id, cfg.VERSION_KEEP),
      ]);
      if (changesOf(results[1]) === 0) continue;
      auditEvents(env, ctx, [{ entryId: id, actorId: identity.userId, event: "updated", payload: {
        stale_confirmed: true,
        prior: { tags, updated_at: row.prior_updated_at, staleness_checked_at: row.staleness_checked_at ?? null },
        ...channelPayload(change),
      } }]);
      return { ok: true, id, action };
    }
    return { ok: false, error: "Could not resolve, try again", status: 409 };
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
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  // Each row's own guard equals its own snapshot's guard (buildCasGuard, spec P3, ADV-1) and pins
  // workspace_id (ADV-2): a row moved out of scope since the caller's own read misses both, instead
  // of the bulk form's old bare-id UPDATE committing a decision the row no longer accounts for.
  const rows: { id: string; tags: string[]; vectorIds: string[]; updateAt: number }[] = [];
  for (const row of found) {
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    if (!tags.includes("auto-insight") || getStatus(tags) === "deprecated") continue;
    const casColumns = { tags: row.tags ?? "[]", workspace_id: row.workspace_id };
    if (action === "confirm") {
      const promoted = withStatus(withKind(tags.filter(t => t !== "auto-insight"), "semantic"), "canonical");
      statements.push(snapshotStatement(env, {
        entryId: row.id, reason: "status", change, content: { kind: "unchanged" }, nextTags: promoted, meta: { insight_action: action }, now,
        guard: p => buildCasGuard(p, casColumns),
      }));
      const p = new Params();
      const tagsIdx = p.add(JSON.stringify(promoted));
      // versioning: snapshot
      statements.push(env.DB.prepare(`UPDATE entries AS e SET tags = ${tagsIdx} WHERE e.id = ${p.add(row.id)} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values()));
    } else {
      const deprecated = withStatus(tags, "deprecated");
      statements.push(snapshotStatement(env, {
        entryId: row.id, reason: "status", change, content: { kind: "unchanged" }, nextTags: deprecated, meta: { insight_action: action }, now,
        guard: p => buildCasGuard(p, casColumns),
      }));
      const p = new Params();
      const tagsIdx = p.add(JSON.stringify(deprecated));
      const vecIdx = p.add("[]");
      // versioning: snapshot
      statements.push(env.DB.prepare(`UPDATE entries AS e SET tags = ${tagsIdx}, vector_ids = ${vecIdx} WHERE e.id = ${p.add(row.id)} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values()));
    }
    rows.push({ id: row.id as string, tags, vectorIds: JSON.parse(row.vector_ids ?? "[]"), updateAt: statements.length - 1 });
  }
  const resolved: string[] = [];
  const auditRows: AuditEventInput[] = [];
  const vectorsToDrop: string[] = [];
  if (statements.length) {
    statements.push(pruneManyStatement(env, rows.map(r => r.id), cfg.VERSION_KEEP));
    const results = await env.DB.batch(statements);
    for (const r of rows) {
      if (changesOf(results[r.updateAt]) === 0) continue;
      resolved.push(r.id);
      auditRows.push({ entryId: r.id, actorId: change.actorId, event: action === "confirm" ? "insight_confirmed" : "insight_dismissed", payload: { prior: { tags: r.tags }, ...channelPayload(change) } });
      if (action === "dismiss") vectorsToDrop.push(...r.vectorIds);
    }
  }
  auditEvents(env, ctx, auditRows);
  if (vectorsToDrop.length) {
    try { await deleteVectorIds(env, vectorsToDrop); }
    catch (e) { console.error("Vectorize deleteByIds failed during bulk dismiss (non-fatal):", e); }
  }
  return { resolved, skipped: requestedCount - resolved.length };
}
