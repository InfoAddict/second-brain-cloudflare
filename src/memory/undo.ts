import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import type { ChangeContext } from "../lib/audit";
import { writeAuditEvents } from "../lib/audit";
import { assertCanMutateEntry, getReadableEntry } from "../lib/entry-access";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { getStatus } from "./status";
import { withUserEditMarker } from "../tags/system";
import { deleteVectorIds } from "../vectorize/batch";
import { reembedOrDegrade, restoreRowVectors } from "../capture/store";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import type { Config } from "../config";
import { getTrashedEntry, restoreEntry } from "./trash";
import {
  canRevert, changesOf, loadHistory, ownSnapshotLandedSql, pruneStatement, snapshotStatement, Params,
  type VersionRow, type WhenChange,
} from "./versions";

export type UndoResult =
  | { status: "reverted"; targetSeq: number; recreatedIncomingId?: string; incomingTruncated?: true }
  | { status: "restored" }
  | { status: "no_change" }
  | { status: "nothing_to_undo" }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "unreadable" }
  | { status: "stale" }
  | { status: "reembed_failed" };

interface EntryRow {
  id: string; workspace_id: string; actor_id: string; content: string; tags: string; source: string;
  vector_ids: string; when_at: number | null; when_kind: string | null; when_source: string | null; when_label: string | null;
}

const ENTRY_COLUMNS = "id, workspace_id, actor_id, content, tags, source, vector_ids, when_at, when_kind, when_source, when_label";

const sortedTagJson = (tags: string[]) => JSON.stringify([...new Set(tags)].sort());
const whenEqual = (a: WhenChange, b: WhenChange) =>
  (a.when_at ?? null) === (b.when_at ?? null)
  && (a.when_kind ?? null) === (b.when_kind ?? null)
  && (a.when_source ?? null) === (b.when_source ?? null)
  && (a.when_label ?? null) === (b.when_label ?? null);

/**
 * Reverses the most recent change to a memory, or a specific earlier version (`toVersion`), or
 * delegates to a trash restore when the row is gone. Design "Undo" (T-0089.1.3).
 */
export async function revertEntry(
  env: Env, identity: Identity | undefined, id: string, change: ChangeContext, config: Readonly<Config>, toVersion?: number,
): Promise<UndoResult> {
  const row = await getReadableEntry(env, identity, id, ENTRY_COLUMNS) as EntryRow | null;
  if (!row) {
    // No live row: undo of a forget, if the trash row is readable (author or admin, same as forget itself).
    const trashed = await getTrashedEntry(env, identity, id);
    if (!trashed) return { status: "not_found" };
    // Same author lock POST /restore enforces (routes/entries.ts): visibility into the trash is not
    // itself permission to bring a company memory back.
    const denied = assertCanMutateEntry(identity, trashed);
    if (denied) return { status: "forbidden" };
    const restored = await restoreEntry(env, trashed, change, config);
    switch (restored.status) {
      case "restored":
        await writeAuditEvents(env, [{
          entryId: id, actorId: change.actorId, event: "restored",
          payload: { channel: change.channel, edgesRestored: restored.edgesRestored, trashedReason: restored.trashedReason },
        }]);
        return { status: "restored" };
      case "reembed_failed": return { status: "reembed_failed" };
      // A racing restore or purge already claimed the trash row between the read above and the batch.
      case "not_found": case "conflict": return { status: "not_found" };
    }
  }

  const chain = await loadHistory(env, identity, { id, content: row.content }, config.VERSION_KEEP);
  if (!chain.rows.length) return { status: "nothing_to_undo" };

  const newest = chain.rows[0];
  const target: VersionRow | undefined = toVersion === undefined ? newest : chain.rows.find(r => r.seq === toVersion);
  if (!target) return { status: "unreadable" };

  const ownerUserId = target.workspace_id === "" ? (await ensureTenantBootstrap(env)).ownerUserId : undefined;
  const verdict = canRevert(identity, { workspace_id: row.workspace_id, actor_id: row.actor_id }, target, newest.seq, chain.rows.map(r => r.seq), { ownerUserId });
  if (!verdict.ok) return { status: verdict.code };

  const isPerson = change.channel === "rest" || change.channel === "mcp";
  const restoredContent = chain.text(target.seq);
  const restoredTagsRaw: string[] = JSON.parse(target.tags);
  const restoredTags = isPerson ? withUserEditMarker(restoredTagsRaw) : restoredTagsRaw;

  const targetState = JSON.parse(target.state || "{}") as WhenChange;
  const targetMeta = JSON.parse(target.meta || "{}") as Record<string, unknown>;
  // A due version, or an append that carried a when, restores when_* alongside content; so does a
  // full rollback to an older state (toVersion), which returns everything to that point in time.
  const restoreWhen = toVersion !== undefined || target.reason === "due" || targetMeta.when === true;
  const nextWhen: WhenChange | undefined = restoreWhen
    ? { when_at: targetState.when_at ?? null, when_kind: targetState.when_kind ?? null, when_source: targetState.when_source ?? null, when_label: targetState.when_label ?? null }
    : undefined;

  const currentWhen: WhenChange = { when_at: row.when_at, when_kind: row.when_kind, when_source: row.when_source, when_label: row.when_label };
  const contentChanged = restoredContent !== row.content;
  const tagsChanged = sortedTagJson(restoredTags) !== sortedTagJson(JSON.parse(row.tags));
  const whenChanged = restoreWhen && !whenEqual(nextWhen!, currentWhen);
  if (!contentChanged && !tagsChanged && !whenChanged) return { status: "no_change" };

  const currentStatus = getStatus(JSON.parse(row.tags));
  const targetStatus = getStatus(restoredTagsRaw);
  const undeprecating = currentStatus === "deprecated" && targetStatus !== "deprecated";
  const needsReembed = targetStatus !== "deprecated" && (contentChanged || undeprecating);
  const embedCtx: WriteContext = { workspaceId: row.workspace_id, actorId: change.actorId || OWNER_WRITE_CONTEXT.actorId };
  const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

  let newVectorIds: string[] | null = null;
  if (needsReembed) {
    try {
      newVectorIds = (await reembedOrDegrade(env, id, restoredContent, restoredTags, row.source, config, embedCtx))?.vectorIds ?? null;
    } catch (e) {
      console.error("Undo re-embed failed — entry left unchanged:", e);
      return { status: "reembed_failed" };
    }
  }
  const nextVectorIds = targetStatus === "deprecated" ? "[]" : newVectorIds ? JSON.stringify(newVectorIds) : row.vector_ids;
  const nextWhenAt = restoreWhen ? nextWhen!.when_at ?? null : row.when_at;
  const nextWhenKind = restoreWhen ? nextWhen!.when_kind ?? null : row.when_kind;
  const nextWhenSource = restoreWhen ? nextWhen!.when_source ?? null : row.when_source;
  const nextWhenLabel = restoreWhen ? nextWhen!.when_label ?? null : row.when_label;

  const nonce = crypto.randomUUID();
  const now = Date.now();
  const p = new Params();
  // One literal, every column always in the SET list: a column not being restored just rebinds its
  // own current value, which keeps this one statement shape instead of several assembled fragments.
  // versioning: snapshot
  const updateSql = `UPDATE entries SET content = ${p.add(restoredContent)}, tags = ${p.add(JSON.stringify(restoredTags))}, updated_at = ${p.add(now)}, vector_ids = ${p.add(nextVectorIds)}, when_at = ${p.add(nextWhenAt)}, when_kind = ${p.add(nextWhenKind)}, when_source = ${p.add(nextWhenSource)}, when_label = ${p.add(nextWhenLabel)} WHERE id = ${p.add(id)} AND ${ownSnapshotLandedSql(p, id, newest.seq, nonce)}`;

  const results = await env.DB.batch([
    snapshotStatement(env, {
      entryId: id, reason: "revert", change,
      content: contentChanged ? { kind: "next", content: restoredContent } : { kind: "unchanged" },
      nextTags: restoredTags, nextWhen, skipNoOp: false, expectNewestSeq: newest.seq,
      meta: { nonce, target_seq: target.seq, reverted_reason: target.reason }, now,
    }),
    // versioning: snapshot
    env.DB.prepare(updateSql).bind(...p.values()),
    pruneStatement(env, id, config.VERSION_KEEP),
  ]);

  if (changesOf(results[1]) === 0) {
    if (newVectorIds) { try { await deleteVectorIds(env, newVectorIds); } catch (e) { console.error("Orphan vector cleanup failed (non-fatal):", e); } }
    // scope-exempt: by-id: the row was read above under the caller's own scope
    const stillThere = await env.DB.prepare(`SELECT 1 AS ok FROM entries WHERE id = ?`).bind(id).first();
    if (!stillThere) return { status: "not_found" };
    if (needsReembed) await restoreRowVectors(env, id, oldVectorIds, newVectorIds ?? [], row.source, config, embedCtx);
    return { status: "stale" };
  }

  if (targetStatus === "deprecated" || needsReembed) {
    const stale = targetStatus === "deprecated" ? oldVectorIds : oldVectorIds.filter(v => !(newVectorIds ?? []).includes(v));
    try { if (stale.length) await deleteVectorIds(env, stale); } catch (e) { console.error("Old vector cleanup failed (non-fatal):", e); }
  }

  await writeAuditEvents(env, [{
    entryId: id, actorId: change.actorId, event: "reverted",
    payload: { target_seq: target.seq, reverted_reason: target.reason, channel: change.channel },
  }]);

  const result: UndoResult = { status: "reverted", targetSeq: target.seq };

  // Undo of a merge or replace re-creates the incoming memory it absorbed, as its own row — never
  // through captureEntry, which could merge it right back in.
  if (target.seq === newest.seq && (target.reason === "merge" || target.reason === "replace") && ("incoming" in targetMeta || targetMeta.incomingTruncated)) {
    if (targetMeta.incomingTruncated) {
      (result as { incomingTruncated?: true }).incomingTruncated = true;
    } else {
      const incoming = String(targetMeta.incoming ?? "");
      const incomingTags: string[] = Array.isArray(targetMeta.incomingTags) ? targetMeta.incomingTags as string[] : [];
      const incomingSource = String(targetMeta.incomingSource ?? row.source);
      const newId = crypto.randomUUID();
      const insertedAt = Date.now();
      try {
        // versioning: exempt: creation — a re-created row has no prior state to keep
        await env.DB.prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`
        ).bind(newId, incoming, JSON.stringify(incomingTags), incomingSource, insertedAt, insertedAt, row.workspace_id, target.actor_id).run();
        try {
          await reembedOrDegrade(env, newId, incoming, incomingTags, incomingSource, config, { workspaceId: row.workspace_id, actorId: target.actor_id });
        } catch (e) {
          console.error("Undo-merge re-embed failed (non-fatal):", e);
        }
        await writeAuditEvents(env, [{ entryId: newId, actorId: target.actor_id, event: "created", payload: { cause: "undo_merge", from: id } }]);
        (result as { recreatedIncomingId?: string }).recreatedIncomingId = newId;
      } catch (e) {
        console.error("Undo-merge recreation failed (non-fatal):", e);
      }
    }
  }

  return result;
}
