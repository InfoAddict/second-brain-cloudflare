import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { scopeWhere, layerOf } from "../lib/scope";
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
  config: Pick<Config, "TRASH_RETENTION_DAYS">;
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
 */
function trashRestoreClause(identity: Identity): { clause: string; bindings: string[] } {
  if (identity.role === "admin") return { clause: "1=1", bindings: [] };
  return {
    clause: "(t.workspace_id = ? OR t.actor_id = ?)",
    bindings: [identity.personalWorkspaceId, identity.userId],
  };
}

/** 160 characters, whitespace collapsed, per contract 4.3. */
function collapsePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * The shared trash listing (BE-1, T-0101.2.1): `GET /trash` and the MCP
 * `list_recent(in_trash: true)` tool both call this. At most 3 D1 statements —
 * the page itself, the deleting client/channel per id, and actor names, the
 * last two skipped when the page is empty or holds no company row.
 *
 * Honest limit: the only index on entries_trash is on deleted_at
 * (db/schema.sql), so this walks the whole brain's trash — bounded by
 * retention, never by brain size. No schema change in this spec.
 */
export async function listTrash(
  env: Env,
  identity: Identity,
  opts: ListTrashOptions,
): Promise<ListTrashResult> {
  const scope = scopeWhere(identity, opts.layer, "t.workspace_id");
  const restore = trashRestoreClause(identity);
  const cursor = opts.cursor ? decodeTrashCursor(opts.cursor) : null;

  const p = new Params();
  const scopeSql = scope.bindings.map((b) => p.add(b)).join(", ");
  const restoreBindings = [...restore.bindings];
  const restoreSql = restoreBindings.length
    ? restore.clause.replace(/\?/g, () => p.add(restoreBindings.shift()))
    : restore.clause;
  const cursorSql = cursor
    ? ` AND (t.deleted_at < ${p.add(cursor.deletedAt)} OR (t.deleted_at = ${p.add(cursor.deletedAt)} AND t.id < ${p.add(cursor.id)}))`
    : "";
  const limitSql = p.add(opts.limit + 1);

  const { results } = await env.DB.prepare(
    `SELECT t.id, substr(t.content, 1, 400) AS preview, t.deleted_at, t.reason, t.deleted_by, t.workspace_id,
            json_extract(t.row_json, '$.source') AS source
       FROM entries_trash t
      WHERE t.workspace_id IN (${scopeSql}) AND ${restoreSql}${cursorSql}
      ORDER BY t.deleted_at DESC, t.id DESC
      LIMIT ${limitSql}`,
  ).bind(...p.values()).all<TrashRow>();

  const rows = results ?? [];
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
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
