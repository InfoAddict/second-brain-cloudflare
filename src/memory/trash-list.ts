import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { scopeWorkspaces, layerOf } from "../lib/scope";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import type { Config } from "../config";
import { Params } from "./params";
import type { TrashReason } from "./trash";

export interface TrashListItem {
  id: string;
  preview: string;
  deleted_at: number;
  days_left: number;
  reason: TrashReason | string;
  channel: string | null;
  client: string | null;
  deleted_by_name: string;
  source: string | null;
  layer: "personal" | "company" | "system";
  can_restore: boolean;
  can_delete_forever: boolean;
}

export interface ListTrashResult {
  items: TrashListItem[];
  nextCursor: string | null;
}

export interface ListTrashOptions {
  limit: number;
  cursor?: string;
  layer?: "personal" | "company";
  config: Readonly<Config>;
}

const DAY_MS = 86_400_000;

/** `<deleted_at>:<id>` per contract 4.3. */
export function encodeTrashCursor(deletedAt: number, id: string): string {
  return `${deletedAt}:${id}`;
}

/** `null` for anything that is not exactly `<number>:<non-empty id>`. */
export function decodeTrashCursor(raw: string): { deletedAt: number; id: string } | null {
  const idx = raw.indexOf(":");
  if (idx < 1) return null;
  const deletedAt = Number(raw.slice(0, idx));
  const id = raw.slice(idx + 1);
  if (!Number.isFinite(deletedAt) || !id) return null;
  return { deletedAt, id };
}

interface TrashRow {
  id: string;
  preview: string;
  deleted_at: number;
  reason: string;
  deleted_by: string;
  workspace_id: string;
  source: string | null;
}

interface DeletedEventRow {
  entry_id: string;
  payload: string;
}

/**
 * Q10: a row is listed only when the reader could restore it — their own
 * personal trash, or a company row where they are either the one who deleted
 * it or an admin. This is the same rule assertCanMutateEntry applies to a live
 * row; a parity test runs both over the same fixture matrix.
 *
 * Decomposed PER WORKSPACE (R5): once workspace_id is pinned to one exact
 * value, "own personal, or admin, or actor is me" collapses to a single
 * residual check (or none at all) that idx_entries_trash_workspace_deleted
 * (db/schema.sql) can run inside that one workspace's index range, rather
 * than an OR the query planner cannot push into a multi-value IN() scan.
 */
function trashRestoreClauseFor(identity: Identity, workspaceId: string): { clause: string; bindings: string[] } {
  if (identity.role === "admin" || workspaceId === identity.personalWorkspaceId) {
    return { clause: "1=1", bindings: [] };
  }
  return { clause: "t.actor_id = ?", bindings: [identity.userId] };
}

/** 160 characters, whitespace collapsed, per contract 4.3. */
function collapsePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** One workspace's own indexed page: a plain seek on idx_entries_trash_workspace_deleted. */
async function pageForWorkspace(
  env: Env,
  identity: Identity,
  workspaceId: string,
  cursor: { deletedAt: number; id: string } | null,
  limit: number,
): Promise<TrashRow[]> {
  const restore = trashRestoreClauseFor(identity, workspaceId);
  const p = new Params();
  const wsSql = p.add(workspaceId);
  const restoreBindings = [...restore.bindings];
  const restoreSql = restoreBindings.length
    ? restore.clause.replace(/\?/g, () => p.add(restoreBindings.shift()))
    : restore.clause;
  const cursorSql = cursor
    ? ` AND (t.deleted_at < ${p.add(cursor.deletedAt)} OR (t.deleted_at = ${p.add(cursor.deletedAt)} AND t.id < ${p.add(cursor.id)}))`
    : "";
  const limitSql = p.add(limit);

  const { results } = await env.DB.prepare(
    `SELECT t.id, substr(t.content, 1, 400) AS preview, t.deleted_at, t.reason, t.deleted_by, t.workspace_id,
            json_extract(t.row_json, '$.source') AS source
       FROM entries_trash t
      WHERE t.workspace_id = ${wsSql} AND ${restoreSql}${cursorSql}
      ORDER BY t.deleted_at DESC, t.id DESC
      LIMIT ${limitSql}`,
  ).bind(...p.values()).all<TrashRow>();
  return results ?? [];
}

function compareTrashRows(a: TrashRow, b: TrashRow): number {
  if (a.deleted_at !== b.deleted_at) return b.deleted_at - a.deleted_at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The shared trash listing (BE-1, T-0101.2.1): `GET /trash` and the MCP
 * `list_recent(in_trash: true)` tool both call this.
 *
 * R5 (budget audit, MINOR, 20-free-tier-ledger.md): one indexed query per
 * readable workspace (idx_entries_trash_workspace_deleted, db/schema.sql),
 * each already ordered and capped at `limit`, merged here — never a single
 * scan across every workspace_id in the caller's IN() list. That combined
 * shape was the original bug: with only deleted_at indexed, SQLite had to
 * walk the whole table in deleted_at order filtering every row it visited for
 * a workspace match (1,193 rows read for a 50-row page at 2,000 trash rows,
 * 5% visible); adding a plain (workspace_id, deleted_at) index instead of
 * restructuring the query made an ENTIRELY-visible brain regress instead
 * (SQLite's planner merge-sorting several IN() branches read more than the
 * old single deleted_at-ordered scan needed to). Per-workspace queries avoid
 * both failure modes: statement count grows with workspace COUNT (typically
 * 1 to 3: personal plus a company or two), never with trash size or
 * visibility. D1 statements: workspace count, plus the deleting client/
 * channel lookup and actor names, the latter two skipped when the page is
 * empty or holds no company row.
 */
export async function listTrash(
  env: Env,
  identity: Identity,
  opts: ListTrashOptions,
): Promise<ListTrashResult> {
  const workspaceIds = scopeWorkspaces(identity, opts.layer);
  const cursor = opts.cursor ? decodeTrashCursor(opts.cursor) : null;
  const perWorkspaceLimit = opts.limit + 1;

  const perWorkspaceRows = await Promise.all(
    workspaceIds.map((workspaceId) => pageForWorkspace(env, identity, workspaceId, cursor, perWorkspaceLimit)),
  );
  const merged = perWorkspaceRows.flat().sort(compareTrashRows);

  const hasMore = merged.length > opts.limit;
  const page = hasMore ? merged.slice(0, opts.limit) : merged;
  const nextCursor = hasMore ? encodeTrashCursor(page[page.length - 1].deleted_at, page[page.length - 1].id) : null;

  if (!page.length) return { items: [], nextCursor: null };

  // The newest `deleted` event per id — client and channel live only in its
  // payload (BE-5), never on the trash row itself. One statement.
  const eventsP = new Params();
  const idsJson = eventsP.add(JSON.stringify(page.map((r) => r.id)));
  const { results: eventRows } = await env.DB.prepare(
    // scope-checked: ids come from the scoped trash read above
    `SELECT entry_id, payload FROM (
       SELECT entry_id, payload, created_at, id,
              ROW_NUMBER() OVER (PARTITION BY entry_id ORDER BY created_at DESC, id DESC) AS rn
         FROM entry_events
        WHERE entry_id IN (SELECT value FROM json_each(${idsJson})) AND event = 'deleted'
     ) WHERE rn = 1`,
  ).bind(...eventsP.values()).all<DeletedEventRow>();

  const eventByEntry = new Map<string, { client: string | null; channel: string | null }>();
  for (const row of eventRows ?? []) {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(row.payload ?? "{}"); } catch { parsed = {}; }
    eventByEntry.set(row.entry_id, {
      client: typeof parsed.client === "string" ? parsed.client : null,
      channel: typeof parsed.channel === "string" ? parsed.channel : null,
    });
  }

  const layerOfRow = (row: TrashRow) => layerOf(identity, row.workspace_id);
  const companyDeletedBy = page.filter((r) => layerOfRow(r) === "company").map((r) => r.deleted_by);
  const labels = companyDeletedBy.length ? await lookupActorLabels(env, companyDeletedBy) : new Map<string, string>();

  const now = Date.now();
  const retentionMs = opts.config.TRASH_RETENTION_DAYS * DAY_MS;
  const items: TrashListItem[] = page.map((row) => {
    const event = eventByEntry.get(row.id);
    return {
      id: row.id,
      preview: collapsePreview(row.preview),
      deleted_at: row.deleted_at,
      days_left: Math.max(0, Math.ceil((row.deleted_at + retentionMs - now) / DAY_MS)),
      reason: row.reason,
      channel: event?.channel ?? null,
      client: event?.client ?? null,
      deleted_by_name: resolveActorLabel(row.deleted_by, labels, { viewerId: identity.userId }),
      source: row.source,
      layer: layerOfRow(row),
      can_restore: true,
      can_delete_forever: true,
    };
  });

  return { items, nextCursor };
}
