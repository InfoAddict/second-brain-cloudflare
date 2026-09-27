import type { Env } from "../env";
import type { Config } from "../config";
import type { ChangeContext } from "../lib/audit";
import {
  TRASH_ROW_BUDGET_BYTES, VERSION_DELETE_CHUNK,
} from "../constants";
import { DISCONNECT_PURGE_CHUNK } from "../constants";
import type { Identity } from "../lib/identity";
import { scopeWhere } from "../lib/scope";
import { assertCanMutateEntry } from "../lib/entry-access";
import { writeAuditEvents, type AuditEventInput } from "../lib/audit";
import { deleteVectorIds } from "../vectorize/batch";
import { edgesJsonSql, rowJsonSql } from "./entry-columns";
import { Params } from "./params";

export type TrashReason = "forget" | "mirror" | "disconnect";

/** Exact bytes a trash insert would write for one entry, read in the same statement as its vector ids. */
export interface TrashSizes {
  content_bytes: number;
  row_json_bytes: number;
  edges_json_bytes: number;
}

export interface TrashCandidate extends TrashSizes {
  id: string;
  workspace_id: string;
  actor_id: string;
  vector_ids: string;
}

/**
 * Which trash form an entry gets, chosen from the sizes SQL computed (never from a D1
 * error): 1 = full row, 2 = without edges, 3 = too large for the trash, hard delete.
 * The 512 bytes cover the fixed columns; the budget leaves headroom under the 2 MB row limit.
 */
export function chooseTrashTier(sizes: TrashSizes, budget = TRASH_ROW_BUDGET_BYTES): 1 | 2 | 3 {
  const base = sizes.content_bytes + sizes.row_json_bytes + 512;
  if (base + sizes.edges_json_bytes <= budget) return 1;
  if (base <= budget) return 2;
  return 3;
}

export interface TrashPlan { tier1: string[]; tier2: string[]; tier3: string[] }

export function planTrash(rows: TrashCandidate[], budget = TRASH_ROW_BUDGET_BYTES): TrashPlan {
  const plan: TrashPlan = { tier1: [], tier2: [], tier3: [] };
  for (const r of rows) {
    const tier = chooseTrashTier(r, budget);
    plan[tier === 1 ? "tier1" : tier === 2 ? "tier2" : "tier3"].push(r.id);
  }
  return plan;
}

/**
 * The size read that replaces forget's `SELECT vector_ids`. `ids` is one JSON array, so the
 * statement binds one parameter however many entries it covers. Callers that need a scope
 * (the disconnect purge) build their own read with the same select list.
 */
export function trashSizeSelect(alias = "e"): string {
  return `${alias}.id, ${alias}.workspace_id, ${alias}.actor_id, ${alias}.vector_ids,
       length(CAST(${alias}.content AS BLOB)) AS content_bytes,
       length(CAST(${rowJsonSql(alias)} AS BLOB)) AS row_json_bytes,
       COALESCE(length(CAST(${edgesJsonSql(alias)} AS BLOB)), 2) AS edges_json_bytes`;
}

export async function readTrashCandidates(env: Env, ids: string[]): Promise<TrashCandidate[]> {
  if (!ids.length) return [];
  const p = new Params();
  const { results } = await env.DB.prepare(
    // scope-exempt: by-id: routes gate with getReadableEntry before calling
    `SELECT ${trashSizeSelect("e")} FROM entries e WHERE e.id IN (SELECT value FROM json_each(${p.add(JSON.stringify(ids))}))`,
  ).bind(...p.values()).all<TrashCandidate>();
  return results ?? [];
}

const TRASH_COLUMNS = "id, workspace_id, actor_id, content, row_json, edges_json, deleted_at, deleted_by, channel, reason";

/**
 * The statements that move entries to the trash, in one batch: the trash inserts (they read
 * the rows and their edges, so they run first), the tier-3 version delete, then the edge and
 * entry deletes. The LAST statement is the entries delete: its `changes` is how many rows this
 * batch actually removed, so a racing deleter is reported as not found.
 */
export function trashManyStatements(
  env: Env,
  plan: TrashPlan,
  meta: { reason: TrashReason; change: ChangeContext; now: number },
): D1PreparedStatement[] {
  const all = [...plan.tier1, ...plan.tier2, ...plan.tier3];
  if (!all.length) return [];
  const stmts: D1PreparedStatement[] = [];
  const insert = (ids: string[], withEdges: boolean) => {
    const p = new Params();
    const idList = p.add(JSON.stringify(ids));
    stmts.push(env.DB.prepare(
      // scope-exempt: by-id: callers authorize the entries before building the batch
      `INSERT OR REPLACE INTO entries_trash (${TRASH_COLUMNS})
       SELECT e.id, e.workspace_id, e.actor_id, e.content, ${rowJsonSql("e")}, ${withEdges ? edgesJsonSql("e") : "'[]'"},
              ${p.add(meta.now)}, ${p.add(meta.change.actorId)}, ${p.add(meta.change.channel)}, ${p.add(meta.reason)}
         FROM entries e WHERE e.id IN (SELECT value FROM json_each(${idList}))`,
    ).bind(...p.values()));
  };
  if (plan.tier1.length) insert(plan.tier1, true);
  if (plan.tier2.length) insert(plan.tier2, false);
  if (plan.tier3.length) {
    const p = new Params();
    stmts.push(env.DB.prepare(
      // scope-exempt: by-id: versions of entries the caller authorized; an oversized entry leaves no history behind
      `DELETE FROM entry_versions WHERE entry_id IN (SELECT value FROM json_each(${p.add(JSON.stringify(plan.tier3))}))`,
    ).bind(...p.values()));
  }
  const ids = JSON.stringify(all);
  {
    const p = new Params();
    const list = p.add(ids);
    stmts.push(env.DB.prepare(
      // scope-exempt: by-id cascade: edge endpoints of the rows being trashed
      `DELETE FROM edges WHERE source_id IN (SELECT value FROM json_each(${list})) OR target_id IN (SELECT value FROM json_each(${list}))`,
    ).bind(...p.values()));
  }
  {
    const p = new Params();
    stmts.push(env.DB.prepare(
      // scope-exempt: by-id delete: callers authorize the entries before building the batch
      `DELETE FROM entries WHERE id IN (SELECT value FROM json_each(${p.add(ids)}))`,
    ).bind(...p.values()));
  }
  return stmts;
}

/** Rows one batch changed, on D1 (`changes`) and the test doubles (`rows_written`). */
export function changedRows(res: { meta?: { changes?: number; rows_written?: number } } | undefined): number {
  return res?.meta?.changes ?? res?.meta?.rows_written ?? 0;
}

// ── Disconnect purge ─────────────────────────────────────────────────────────

/**
 * Trash mirrored entries for the disconnect purge, in chunks of DISCONNECT_PURGE_CHUNK: per chunk one
 * scoped read, one batch (trash, edges, entries) and one audit batch. Rows the caller cannot see or
 * mutate, and ids already gone, are counted skipped and never touched. Nothing here runs a purge batch.
 */
export async function trashMirroredEntries(
  env: Env,
  auth: Identity,
  entryIds: string[],
  opts: { provider: string; budget?: number },
): Promise<{ purged: number; skipped: number }> {
  let purged = 0;
  let skipped = 0;
  for (let i = 0; i < entryIds.length; i += DISCONNECT_PURGE_CHUNK) {
    const chunk = [...new Set(entryIds.slice(i, i + DISCONNECT_PURGE_CHUNK))];
    const scope = scopeWhere(auth, undefined, "e.workspace_id");
    const { results } = await env.DB.prepare(
      // Bare placeholders throughout: the scope clause brings its own.
      `SELECT ${trashSizeSelect("e")} FROM entries e WHERE e.id IN (SELECT value FROM json_each(?)) AND ${scope.clause}`,
    ).bind(JSON.stringify(chunk), ...scope.bindings).all<TrashCandidate>();
    // Same guard /forget applies: a purge removes only what this caller could delete one at a time.
    const allowed = (results ?? []).filter((r) => !assertCanMutateEntry(auth, r));
    skipped += entryIds.slice(i, i + DISCONNECT_PURGE_CHUNK).length - allowed.length;
    if (!allowed.length) continue;

    const plan = planTrash(allowed, opts.budget);
    const now = Date.now();
    const change = { actorId: auth.userId, channel: "rest" as const };
    const batch = await env.DB.batch(trashManyStatements(env, plan, { reason: "disconnect", change, now }));
    const removed = changedRows(batch[batch.length - 1]);
    let done = allowed;
    if (removed !== allowed.length) {
      // A racing deleter took some between the read and the batch: audit only what this batch removed.
      const p = new Params();
      const { results: landed } = await env.DB.prepare(
        // scope-exempt: by-id: the trash rows this batch just wrote, to tell them from a racer's deletes
        `SELECT id FROM entries_trash WHERE reason = 'disconnect' AND deleted_at = ${p.add(now)} AND deleted_by = ${p.add(auth.userId)}
            AND id IN (SELECT value FROM json_each(${p.add(JSON.stringify(allowed.map((r) => r.id)))}))`,
      ).bind(...p.values()).all<{ id: string }>();
      const landedIds = new Set((landed ?? []).map((r) => r.id));
      // A hard-deleted (tier 3) row leaves no trash row to find, so it is taken as removed.
      const hard = new Set(plan.tier3);
      done = allowed.filter((r) => landedIds.has(r.id) || hard.has(r.id));
    }
    purged += removed;
    skipped += allowed.length - removed;

    const vectorIds = done.flatMap((r) => { try { return JSON.parse(r.vector_ids ?? "[]") as string[]; } catch { return []; } });
    try {
      if (vectorIds.length) await deleteVectorIds(env, vectorIds);
    } catch (e) {
      console.error("Vectorize delete failed during disconnect purge (non-fatal):", e);
    }

    const tier3 = new Set(plan.tier3);
    const tier2 = new Set(plan.tier2);
    const events: AuditEventInput[] = done.map((r) => ({
      entryId: r.id,
      actorId: auth.userId,
      event: "deleted",
      payload: {
        reason: "disconnect", provider: opts.provider,
        deletedVectors: (() => { try { return (JSON.parse(r.vector_ids ?? "[]") as string[]).length; } catch { return 0; } })(),
        trash: !tier3.has(r.id), channel: "rest",
        ...(tier2.has(r.id) ? { edgesDropped: true } : {}),
        ...(tier3.has(r.id) ? { tooLargeForTrash: true } : {}),
      },
    }));
    await writeAuditEvents(env, events);
  }
  return { purged, skipped };
}

// ── Purge ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** The lowest TRASH_RETENTION_DAYS the config accepts (src/config.ts RULES). */
const MIN_RETENTION_DAYS = 1;
/** Rows written to purge one trash row: the purged event (4) and the trash row (3), plus 2 per version. */
const PURGE_ROW_COST = 7;

/** A ceiling on the trash rows a purge reads, sized for rows holding VERSION_KEEP versions (the batch is still costed from the real counts). */
export function purgeLimit(versionKeep: number, ceiling: number, rowTarget: number): number {
  return Math.max(1, Math.min(ceiling, Math.floor(rowTarget / (PURGE_ROW_COST + 2 * versionKeep))));
}

export interface PurgeResult {
  /** Trash rows the candidate read returned. */
  read: number;
  purged: number;
  /** Versions trimmed from one oversized row instead of purging it. */
  trimmed: number;
  rowsWritten: number;
}

/**
 * One bounded purge: a candidate read with the REAL version count of each, then one batch over
 * the longest prefix whose cost fits `rowTarget` (and `rowsLeft`, the night's remaining budget).
 * A row trashed at a higher VERSION_KEEP is therefore costed at what it holds, not at what the
 * current keep implies. A first candidate that alone exceeds the target has its oldest versions
 * deleted instead (bottom-up, so the chain stays valid until the final batch).
 */
export async function purgeTrash(
  env: Env,
  cfg: Readonly<Config> | (() => Promise<Readonly<Config>>),
  opts: { ceiling: number; rowTarget: number; rowsLeft?: number; now?: number },
): Promise<PurgeResult> {
  const now = opts.now ?? Date.now();
  // The shortest retention the config allows: nothing younger can be expired, so a night with an
  // empty trash never needs the config (one KV read saved on every nightly run).
  const earliest = now - MIN_RETENTION_DAYS * DAY_MS;
  const budget = Math.min(opts.rowTarget, opts.rowsLeft ?? Infinity);
  const none: PurgeResult = { read: 0, purged: 0, trimmed: 0, rowsWritten: 0 };
  if (budget < PURGE_ROW_COST) return none;

  const rp = new Params();
  const { results } = await env.DB.prepare(
    // scope-exempt: retention purge: global by design, bounded by the LIMIT and the row budget
    `SELECT t.id, t.deleted_at, (SELECT COUNT(*) FROM entry_versions v WHERE v.entry_id = t.id) AS n
       FROM entries_trash t WHERE t.deleted_at < ${rp.add(earliest)}
      ORDER BY t.deleted_at, t.id LIMIT ${rp.add(opts.ceiling)}`,
  ).bind(...rp.values()).all<{ id: string; deleted_at: number; n: number }>();
  let candidates = results ?? [];
  if (!candidates.length) return none;
  // Oldest first, so the expired rows are a prefix: cut at the configured retention.
  const days = (typeof cfg === "function" ? await cfg() : cfg).TRASH_RETENTION_DAYS;
  const cutoff = now - days * DAY_MS;
  candidates = candidates.filter((c) => c.deleted_at < cutoff);
  if (!candidates.length) return none;

  const chosen: string[] = [];
  let cost = 0;
  for (const c of candidates) {
    const next = PURGE_ROW_COST + 2 * Number(c.n);
    if (cost + next > budget) break;
    chosen.push(c.id);
    cost += next;
  }

  if (!chosen.length) {
    // Even the first row does not fit. If it is the row itself that is oversized, trim its oldest versions.
    const first = candidates[0];
    const chunk = Math.min(VERSION_DELETE_CHUNK, Math.floor(budget / 2));
    if (chunk < 1) return { ...none, read: candidates.length };
    const tp = new Params();
    const res = await env.DB.prepare(
      // scope-exempt: retention purge of one trashed entry's versions, oldest first, only while the id is not live
      `DELETE FROM entry_versions WHERE id IN (
         SELECT v.id FROM entry_versions v WHERE v.entry_id = ${tp.add(first.id)} AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.id = v.entry_id)
          ORDER BY v.seq LIMIT ${tp.add(chunk)})`,
    ).bind(...tp.values()).run();
    const trimmed = changedRows(res);
    return { read: candidates.length, purged: 0, trimmed, rowsWritten: rowsWrittenOf([res], 2 * trimmed) };
  }

  const p = new Params();
  const ids = p.add(JSON.stringify(chosen));
  const now$ = p.add(now);
  const results3 = await env.DB.batch([
    env.DB.prepare(
      // scope-exempt: retention purge: the audit row of each expired trash row, in the batch that removes it
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
       SELECT lower(hex(randomblob(16))), t.id, '', 'purged',
              json_object('channel', 'system:purge', 'reason', t.reason, 'deleted_at', t.deleted_at), ${now$}
         FROM entries_trash t WHERE t.id IN (SELECT value FROM json_each(${ids}))`,
    ).bind(...p.values()),
    env.DB.prepare(
      // scope-exempt: retention purge: versions of expired trash rows, never of a live entry
      `DELETE FROM entry_versions WHERE entry_id IN (SELECT value FROM json_each(${ids}))
         AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.id = entry_versions.entry_id)`,
    ).bind(...p.values()),
    env.DB.prepare(
      // scope-exempt: retention purge: expired trash rows
      `DELETE FROM entries_trash WHERE id IN (SELECT value FROM json_each(${ids}))`,
    ).bind(...p.values()),
  ]);
  const purged = changedRows(results3[2]);
  const estimate = 4 * changedRows(results3[0]) + 2 * changedRows(results3[1]) + 3 * purged;
  return { read: candidates.length, purged, trimmed: 0, rowsWritten: rowsWrittenOf(results3, estimate) };
}

/** Rows written by a batch: the larger of D1's own count and the estimate (the test doubles report only changes). */
function rowsWrittenOf(results: Array<{ meta?: { rows_written?: number } } | undefined>, estimate = 0): number {
  const sum = results.reduce((n, r) => n + (r?.meta?.rows_written ?? 0), 0);
  return Math.max(sum, estimate);
}
