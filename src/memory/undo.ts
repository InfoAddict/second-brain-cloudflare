import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import type { ChangeContext } from "../lib/audit";
import { writeAuditEvents } from "../lib/audit";
import { assertCanMutateEntry, getReadableEntry } from "../lib/entry-access";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { getStatus } from "./status";
import { withUserEditMarker } from "../tags/system";
import { deleteVectorIds } from "../vectorize/batch";
import { reembedOrDegrade, restoreRowVectors, upsertEntryVectors, type StoredEntry } from "../capture/store";
import { forgetEntry } from "../capture/lifecycle";
import { isVectorizeUnavailable } from "../vectorize/health";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import type { Config } from "../config";
import { getTrashedEntry, restoreEntry } from "./trash";
import {
  buildCasGuard, canRevert, changesOf, loadHistory, ownSnapshotLandedSql, pruneStatement, snapshotStatement, Params,
  type VersionRow, type WhenChange,
} from "./versions";

export type UndoResult =
  | { status: "reverted"; targetSeq: number; recreatedIncomingId?: string; incomingTruncated?: true; keptIncoming?: { id: string; reason: string }[] }
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
 * Same fail-closed / degrade-on-outage contract as `reembedOrDegrade`, but without its own
 * `UPDATE entries SET vector_ids` — the revert's batch already sets that column itself, and running
 * both was a fifth, redundant statement the spec's 4-statement budget does not allow (U5).
 */
async function reembedForRevert(
  env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config>, writeCtx: WriteContext,
): Promise<StoredEntry | null> {
  try {
    const stored = await upsertEntryVectors(env, id, content, tags, source, Date.now(), config, writeCtx);
    if (!stored.vectorIds.length) throw new Error("re-embed produced no vectors");
    return stored;
  } catch (e) {
    if (!(await isVectorizeUnavailable(env))) throw e;
    console.error("Vectorize unavailable — committing content without re-embedding:", e);
    return null;
  }
}

/**
 * Reverses the most recent change to a memory, or a specific earlier version (`toVersion`), or
 * delegates to a trash restore when the row is gone. Design "Undo" (T-0089.1.3).
 */
export async function revertEntry(
  env: Env, identity: Identity | undefined, id: string, change: ChangeContext, config: Readonly<Config>, toVersion?: number,
  /** Pins the CAS guard to the workspace the caller's own scoped read authorized (Task 15's route),
   * rather than the read this function makes moments later. Falls back to that read when absent. */
  authorizedWorkspaceId?: string,
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

  // What a merge/replace revert recorded about a row it re-created, so a later redo can tell whether
  // that row is still exactly what this mechanism left behind (U8), and which merge it belongs to
  // (U10, so a further rollback to the same merge can tell it is already covered).
  const isIncomingSnapshot = (v: unknown): v is { id: string; content: string; workspace_id: string; actor_id: string; merge_seq: number } =>
    !!v && typeof v === "object"
    && typeof (v as Record<string, unknown>).id === "string" && typeof (v as Record<string, unknown>).content === "string"
    && typeof (v as Record<string, unknown>).workspace_id === "string" && typeof (v as Record<string, unknown>).actor_id === "string"
    && typeof (v as Record<string, unknown>).merge_seq === "number";
  const isRemovedIncoming = (v: unknown): v is { id: string; merge_seq: number } =>
    !!v && typeof v === "object" && typeof (v as Record<string, unknown>).id === "string" && typeof (v as Record<string, unknown>).merge_seq === "number";
  const asIncomingSnapshots = (v: unknown) => Array.isArray(v) ? v.filter(isIncomingSnapshot) : [];
  const asRemovedIncoming = (v: unknown) => Array.isArray(v) ? v.filter(isRemovedIncoming) : [];

  /** Whether an earlier recreation of this merge's incoming row is still live, so this call does not duplicate it (U10). */
  async function findLiveIncomingRecreation(mergeSeq: number): Promise<boolean> {
    for (const r of chain.rows) {
      if (r.reason !== "revert") continue;
      let m: Record<string, unknown>;
      try { m = JSON.parse(r.meta || "{}"); } catch { continue; }
      const hit = asIncomingSnapshots(m.recreated_incoming).find(s => s.merge_seq === mergeSeq);
      if (!hit) continue;
      // scope-exempt: by-id: checking whether a row this mechanism itself created earlier is still live
      if (await env.DB.prepare(`SELECT 1 AS ok FROM entries WHERE id = ?`).bind(hit.id).first()) return true;
    }
    return false;
  }

  // Rolling back to (or past) a merge/replace pulls its absorbed text out of the live row, wherever
  // it sits in the chain: a to_version rollback can skip over several merges at once, not only land
  // on one (U10), so every version between the target and the newest, inclusive, whose reason is
  // merge or replace gets its own re-created row — unless a still-live row from an earlier rollback
  // to that same merge already covers it. Ids are minted now, before the batch, so they can ride in
  // this revert's own version meta.
  const mergesInRange = chain.rows.filter(r => r.seq >= target.seq && r.seq <= newest.seq && (r.reason === "merge" || r.reason === "replace"));
  const mergesToCreate: { merge: VersionRow; meta: Record<string, unknown>; id: string }[] = [];
  let anyIncomingTruncated = false;
  for (const merge of mergesInRange) {
    let mergeMeta: Record<string, unknown>;
    try { mergeMeta = JSON.parse(merge.meta || "{}"); } catch { mergeMeta = {}; }
    if (mergeMeta.incomingTruncated === true) { anyIncomingTruncated = true; continue; }
    if (!("incoming" in mergeMeta)) continue;
    if (await findLiveIncomingRecreation(merge.seq)) continue;
    mergesToCreate.push({ merge, meta: mergeMeta, id: crypto.randomUUID() });
  }
  const createdIncoming = mergesToCreate.map(m => ({
    id: m.id, content: String(m.meta.incoming ?? ""), workspace_id: row.workspace_id, actor_id: m.merge.actor_id, merge_seq: m.merge.seq,
  }));

  // Undoing a revert that itself re-created incoming rows (a redo) must remove them again, so the
  // fact does not end up live in two places (U4) — but only when it is still safe to (U8): still
  // readable and mutable by this undoer, and unchanged since this mechanism created it. A row moved
  // out of the undoer's reach, edited by someone else, or no longer theirs to forget is left alone,
  // and the result says so rather than silently keeping (or losing) it.
  const priorIncoming = target.reason === "revert" ? asIncomingSnapshots(targetMeta.recreated_incoming) : [];
  const removingIncoming: typeof priorIncoming = [];
  const keptIncoming: { id: string; reason: string }[] = [];
  for (const snap of priorIncoming) {
    const incomingRow = await getReadableEntry(env, identity, snap.id, "id, workspace_id, actor_id, content");
    const incomingDenied = incomingRow ? assertCanMutateEntry(identity, incomingRow) : null;
    const incomingUnchanged = !!incomingRow
      && incomingRow.content === snap.content
      && incomingRow.workspace_id === snap.workspace_id
      && incomingRow.actor_id === snap.actor_id;
    if (incomingRow && !incomingDenied && incomingUnchanged) removingIncoming.push(snap);
    else keptIncoming.push({ id: snap.id, reason: !incomingRow ? "unreadable" : incomingDenied ? "forbidden" : "changed" });
  }

  // The mirror image (U9): undoing a redo that had trashed re-created rows brings them back, with the
  // same author-or-admin guard restoring from the trash always uses (U1), and records them again so a
  // further redo can remove them once more — the two actions stay symmetric indefinitely.
  const priorRemoved = target.reason === "revert" ? asRemovedIncoming(targetMeta.removed_incoming) : [];
  const restoringIncoming: { trashed: Awaited<ReturnType<typeof getTrashedEntry>> & object; mergeSeq: number }[] = [];
  for (const rem of priorRemoved) {
    const trashedIncoming = await getTrashedEntry(env, identity, rem.id);
    const trashedDenied = trashedIncoming ? assertCanMutateEntry(identity, trashedIncoming) : null;
    if (trashedIncoming && !trashedDenied) restoringIncoming.push({ trashed: trashedIncoming, mergeSeq: rem.merge_seq });
  }
  const restoredIncoming = restoringIncoming.map(r => ({
    id: r.trashed.id, content: r.trashed.content, workspace_id: r.trashed.workspace_id, actor_id: r.trashed.actor_id, merge_seq: r.mergeSeq,
  }));
  const metaRecreatedIncoming = [...createdIncoming, ...restoredIncoming];
  const metaRemovedIncoming = removingIncoming.map(s => ({ id: s.id, merge_seq: s.merge_seq }));

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
      newVectorIds = (await reembedForRevert(env, id, restoredContent, restoredTags, row.source, config, embedCtx))?.vectorIds ?? null;
    } catch (e) {
      console.error("Undo re-embed failed — entry left unchanged:", e);
      return { status: "reembed_failed" };
    }
  }
  // Only set when this revert actually touched the vector index (re-embedded, or deprecating/
  // undeprecating). Otherwise leaving it out of the UPDATE, rather than rebinding this call's own
  // stale read, is what stops a re-index that lands mid-undo from being erased (U11).
  const nextVectorIds = needsReembed ? (newVectorIds ? JSON.stringify(newVectorIds) : undefined) : targetStatus === "deprecated" ? "[]" : undefined;

  const nonce = crypto.randomUUID();
  const now = Date.now();
  // Pinned at authorization (the caller's own scoped read, or this function's read moments ago),
  // never at the write: a share/unshare writes no version, so without this a concurrent move leaves
  // MAX(seq) unchanged and an admin's undo can commit into the row after it left their reach (U3, R2-7).
  const pinnedWorkspaceId = authorizedWorkspaceId ?? row.workspace_id;
  const workspaceGuard = (guardP: Params) => buildCasGuard(guardP, { workspace_id: pinnedWorkspaceId });
  const p = new Params();
  // The when_* columns are set only when this revert is actually restoring the date. Rebinding them
  // from this call's own stale JS read, as every other column here does, would silently erase a date
  // some other write (the unversioned when pass, when/pass.ts) set in the meantime (U7).
  const whenSet = restoreWhen
    ? `, when_at = ${p.add(nextWhen!.when_at ?? null)}, when_kind = ${p.add(nextWhen!.when_kind ?? null)}, when_source = ${p.add(nextWhen!.when_source ?? null)}, when_label = ${p.add(nextWhen!.when_label ?? null)}`
    : "";
  const vectorIdsSet = nextVectorIds !== undefined ? `, vector_ids = ${p.add(nextVectorIds)}` : "";
  // versioning: snapshot
  const updateSql = `UPDATE entries AS e SET content = ${p.add(restoredContent)}, tags = ${p.add(JSON.stringify(restoredTags))}, updated_at = ${p.add(now)}${vectorIdsSet}${whenSet} WHERE e.id = ${p.add(id)} AND ${workspaceGuard(p)} AND ${ownSnapshotLandedSql(p, id, newest.seq, nonce)}`;

  let results;
  try {
    results = await env.DB.batch([
      snapshotStatement(env, {
        entryId: id, reason: "revert", change,
        content: contentChanged ? { kind: "next", content: restoredContent } : { kind: "unchanged" },
        nextTags: restoredTags, nextWhen, skipNoOp: false, expectNewestSeq: newest.seq, guard: workspaceGuard,
        // Recorded whenever this revert restores the date, so a later undo of THIS version (a redo)
        // knows to restore when_* too, the same way an append-with-when or a due version does (U2).
        // recreated_incoming rides along the same way, with enough of a snapshot (content, workspace,
        // actor) that a redo of this revert (undoing it) can tell whether the row it names is still
        // safe to remove (U8), not just which row to look at. removed_incoming is its mirror (U9): a
        // later undo of a redo restores exactly that row from the trash and re-stamps recreated_incoming,
        // so the pair stays symmetric across as many undo/redo cycles as the caller runs.
        meta: {
          nonce, target_seq: target.seq, reverted_reason: target.reason,
          ...(restoreWhen ? { when: true } : {}),
          ...(metaRecreatedIncoming.length ? { recreated_incoming: metaRecreatedIncoming } : {}),
          ...(metaRemovedIncoming.length ? { removed_incoming: metaRemovedIncoming } : {}),
        }, now,
      }),
      // versioning: snapshot
      env.DB.prepare(updateSql).bind(...p.values()),
      pruneStatement(env, id, config.VERSION_KEEP),
    ]);
  } catch (e) {
    // The re-embed above already pointed the row's deterministic vector ids at the restored text; a
    // thrown batch means the row itself never committed, so the index and the row would disagree
    // until the next write touched it. Re-embed from the row as it actually stands (U6) — never
    // delete under those ids, which are the row's live vectors (the rule ADV proved broken elsewhere).
    if (needsReembed) await restoreRowVectors(env, id, oldVectorIds, newVectorIds ?? [], row.source, config, embedCtx);
    throw e;
  }

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
  // through captureEntry, which could merge it right back in. Fires for every merge a to_version
  // rollback skips past, not only when a merge is the newest change (U4, U10).
  if (anyIncomingTruncated) (result as { incomingTruncated?: true }).incomingTruncated = true;
  const insertedIncomingIds: string[] = [];
  for (const create of mergesToCreate) {
    const incoming = String(create.meta.incoming ?? "");
    const incomingTags: string[] = Array.isArray(create.meta.incomingTags) ? create.meta.incomingTags as string[] : [];
    const incomingSource = String(create.meta.incomingSource ?? row.source);
    const insertedAt = Date.now();
    try {
      // versioning: exempt: creation — a re-created row has no prior state to keep
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`
      ).bind(create.id, incoming, JSON.stringify(incomingTags), incomingSource, insertedAt, insertedAt, row.workspace_id, create.merge.actor_id).run();
      try {
        await reembedOrDegrade(env, create.id, incoming, incomingTags, incomingSource, config, { workspaceId: row.workspace_id, actorId: create.merge.actor_id });
      } catch (e) {
        console.error("Undo-merge re-embed failed (non-fatal):", e);
      }
      await writeAuditEvents(env, [{ entryId: create.id, actorId: create.merge.actor_id, event: "created", payload: { cause: "undo_merge", from: id } }]);
      insertedIncomingIds.push(create.id);
    } catch (e) {
      console.error("Undo-merge recreation failed (non-fatal):", e);
    }
  }
  if (insertedIncomingIds.length) (result as { recreatedIncomingId?: string }).recreatedIncomingId = insertedIncomingIds[0];

  // A redo (undoing a revert that had re-created incoming rows) removes them again, through the
  // trash so the removal is itself reversible, rather than leaving a fact live in two places. Only
  // ever reached when the guards above (readable, mutable, unchanged) already passed (U8).
  for (const remove of removingIncoming) {
    try {
      const forgotten = await forgetEntry(remove.id, env, change, { reason: "forget", config, purge: false });
      if (forgotten.status === "deleted") {
        await writeAuditEvents(env, [{
          entryId: remove.id, actorId: change.actorId, event: "deleted",
          payload: { channel: change.channel, trash: forgotten.trashed, reason: "forget", cause: "undo_merge_redo" },
        }]);
      }
    } catch (e) {
      console.error("Undo-merge redo cleanup failed (non-fatal):", e);
    }
  }
  if (keptIncoming.length) (result as { keptIncoming?: { id: string; reason: string }[] }).keptIncoming = keptIncoming;

  // The mirror of the removal above (U9): undoing a redo that had trashed re-created rows restores
  // them, under the same author-or-admin guard POST /restore enforces (U1) — checked before the
  // batch, above, so this is just carrying out a decision already made.
  for (const restore of restoringIncoming) {
    try {
      const restored = await restoreEntry(env, restore.trashed, change, config);
      if (restored.status === "restored") {
        await writeAuditEvents(env, [{
          entryId: restore.trashed.id, actorId: change.actorId, event: "restored",
          payload: { channel: change.channel, edgesRestored: restored.edgesRestored, trashedReason: restored.trashedReason },
        }]);
      }
    } catch (e) {
      console.error("Undo-merge restore-from-trash failed (non-fatal):", e);
    }
  }

  return result;
}
