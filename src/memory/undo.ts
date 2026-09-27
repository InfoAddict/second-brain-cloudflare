import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import type { ChangeContext } from "../lib/audit";
import { writeAuditEvents } from "../lib/audit";
import { assertCanMutateEntry, getReadableEntry } from "../lib/entry-access";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { getStatus } from "./status";
import { withUserEditMarker } from "../tags/system";
import { deleteVectorIds } from "../vectorize/batch";
import { restoreRowVectors, upsertEntryVectors, type StoredEntry } from "../capture/store";
import { isVectorizeUnavailable } from "../vectorize/health";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import type { Config } from "../config";
import { VERSION_ROW_BUDGET_BYTES } from "../constants";
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
  content_bytes: number; tags_bytes: number;
}

const ENTRY_COLUMNS = "id, workspace_id, actor_id, content, tags, source, vector_ids, when_at, when_kind, when_source, when_label, "
  + "length(CAST(content AS BLOB)) AS content_bytes, length(CAST(tags AS BLOB)) AS tags_bytes";

/** Which merge (by its version seq) a re-created row's fact came from. No content, no owner fields:
 * a merge's incoming is re-created at most once, ever, so nothing here needs to describe the row —
 * only find it again (or find that it was already handled) without a byte of duplicated text. */
interface RecordedIncoming { id: string; merge_seq: number }
const isRecordedIncoming = (v: unknown): v is RecordedIncoming =>
  !!v && typeof v === "object" && typeof (v as Record<string, unknown>).id === "string" && typeof (v as Record<string, unknown>).merge_seq === "number";
const asRecordedIncoming = (v: unknown): RecordedIncoming[] => Array.isArray(v) ? v.filter(isRecordedIncoming) : [];

const sortedTagJson = (tags: string[]) => JSON.stringify([...new Set(tags)].sort());
const whenEqual = (a: WhenChange, b: WhenChange) =>
  (a.when_at ?? null) === (b.when_at ?? null)
  && (a.when_kind ?? null) === (b.when_kind ?? null)
  && (a.when_source ?? null) === (b.when_source ?? null)
  && (a.when_label ?? null) === (b.when_label ?? null);
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * Same fail-closed / degrade-on-outage contract as `reembedOrDegrade`, but without its own
 * `UPDATE entries SET vector_ids` — a caller that already has an INSERT or UPDATE of its own to carry
 * the ids sets them there instead, so a batch never runs a second, redundant write for the same row
 * (U5, and U14's re-created rows).
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
  env: Env, identity: Identity | undefined, id: string, change: ChangeContext, config: Readonly<Config>, toVersion: number | undefined,
  /**
   * Pins the CAS guard to the workspace the caller's own scoped read authorized (Class 1,
   * T-0089.6.6's route and MCP tool), rather than the read this function makes moments later — an
   * unshare landing in that gap must miss the guard, not silently authorize against wherever the
   * row ended up. Required, not defaulted to this function's own read: a caller with no scoped
   * read of its own has no business calling this at all. When there is no live row (the trash
   * path), this value is never consumed — any string is fine, since restoreEntry has its own
   * scoping through getTrashedEntry.
   */
  authorizedWorkspaceId: string,
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

  /**
   * Whether this merge's incoming row has already been re-created, anywhere in the visible chain,
   * whatever has happened to that row since — live, edited, moved, trashed or gone (U10, U13, U15,
   * U16). A merge's fact is re-created at MOST ONCE, EVER: this is a pure lookup over versions
   * already in hand, no DB read, so it costs nothing against the statement budget (U14).
   */
  function findRecordedIncoming(mergeSeq: number): RecordedIncoming | undefined {
    for (const r of chain.rows) {
      if (r.reason !== "revert") continue;
      let m: Record<string, unknown>;
      try { m = JSON.parse(r.meta || "{}"); } catch { continue; }
      const hit = asRecordedIncoming(m.recreated_incoming).find(s => s.merge_seq === mergeSeq);
      if (hit) return hit;
    }
    return undefined;
  }

  // Rolling back to (or past) a merge/replace pulls its absorbed text out of the live row, wherever
  // it sits in the chain: a to_version rollback can cross several merges at once, not only land on
  // one (U10), so every version between the target and the newest, inclusive, whose reason is merge
  // or replace gets its own re-created row — unless it was already re-created at some point, in which
  // case it is left exactly alone (never resurrected, never duplicated) and reported as kept.
  const mergesInRange = chain.rows.filter(r => r.seq >= target.seq && r.seq <= newest.seq && (r.reason === "merge" || r.reason === "replace"));
  const mergesToCreate: { merge: VersionRow; meta: Record<string, unknown>; id: string }[] = [];
  const keptIncoming: { id: string; reason: string }[] = [];
  let anyIncomingTruncated = false;
  for (const merge of mergesInRange) {
    const already = findRecordedIncoming(merge.seq);
    if (already) { keptIncoming.push({ id: already.id, reason: "already recreated" }); continue; }
    let mergeMeta: Record<string, unknown>;
    try { mergeMeta = JSON.parse(merge.meta || "{}"); } catch { mergeMeta = {}; }
    if (mergeMeta.incomingTruncated === true) { anyIncomingTruncated = true; continue; }
    if (!("incoming" in mergeMeta)) continue;
    mergesToCreate.push({ merge, meta: mergeMeta, id: crypto.randomUUID() });
  }

  // Undoing a merge undo (a redo) never removes the row that undo re-created (Director decision,
  // T-0089.1.3 round 3): it just restores the merged text and leaves that row exactly as it is,
  // reporting it every time so whoever is looking can see the fact now lives in two places and
  // remove one on purpose. The record travels forward on every hop so this keeps working no matter
  // how many undo/redo cycles run.
  // "re-created earlier" rather than a claim like "kept as its own memory" (U20): this report costs
  // no DB read, so it cannot say whether the row is still there, still that content, or gone for
  // good — Task 15 surfaces this text to users, and it must never assert a memory exists that does not.
  const inheritedIncoming = target.reason === "revert" ? asRecordedIncoming(targetMeta.recreated_incoming) : [];
  for (const entry of inheritedIncoming) keptIncoming.push({ id: entry.id, reason: "re-created earlier" });

  const recreatedForMeta: RecordedIncoming[] = [
    ...inheritedIncoming,
    ...mergesToCreate.map(m => ({ id: m.id, merge_seq: m.merge.seq })),
  ];

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
  // Pinned at authorization (the caller's own scoped read), never at the write: a share/unshare
  // writes no version, so without this a concurrent move leaves MAX(seq) unchanged and an admin's
  // undo can commit into the row after it left their reach (U3, R2-7, Class 1).
  const workspaceGuard = (guardP: Params) => buildCasGuard(guardP, { workspace_id: authorizedWorkspaceId });
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

  // Embedded before the batch, like the main content above, so the insert below can carry its own
  // vector_ids the way restoreEntry does (U14). Each insert is guarded by the SAME "this request's own
  // snapshot landed" condition as the UPDATE, and runs INSIDE the revert's own batch, not a separate
  // one after it: the row and the meta that records it now commit together or not at all — a thrown
  // or lost insert can no longer leave the record saying a row exists that was never created, which
  // would otherwise block every future rollback from ever trying again (U18).
  const insertedAt = Date.now();
  const incomingInserts: { id: string; vectorIds: string[]; actorId: string }[] = [];
  const incomingStatements: D1PreparedStatement[] = [];
  for (const create of mergesToCreate) {
    const incoming = String(create.meta.incoming ?? "");
    const incomingTags: string[] = Array.isArray(create.meta.incomingTags) ? create.meta.incomingTags as string[] : [];
    const incomingSource = String(create.meta.incomingSource ?? row.source);
    let vectorIds: string[] = [];
    try {
      vectorIds = (await reembedForRevert(env, create.id, incoming, incomingTags, incomingSource, config, { workspaceId: row.workspace_id, actorId: create.merge.actor_id }))?.vectorIds ?? [];
    } catch (e) {
      console.error("Undo-merge re-embed failed (non-fatal):", e);
    }
    incomingInserts.push({ id: create.id, vectorIds, actorId: create.merge.actor_id });
    const ip = new Params();
    // versioning: exempt: creation — a re-created row has no prior state to keep
    incomingStatements.push(env.DB.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       SELECT ${ip.add(create.id)}, ${ip.add(incoming)}, ${ip.add(JSON.stringify(incomingTags))}, ${ip.add(incomingSource)}, ${ip.add(insertedAt)}, ${ip.add(insertedAt)}, ${ip.add(JSON.stringify(vectorIds))}, ${ip.add(row.workspace_id)}, ${ip.add(create.merge.actor_id)}
        WHERE ${ownSnapshotLandedSql(ip, id, newest.seq, nonce)}`,
    ).bind(...ip.values()));
  }

  // Row budget (U13, same rule the merge writer applies to its own version row, P16): a rollback from
  // a long, merged state back to a short one cannot use the delta encoding (that needs the CURRENT
  // text to be a PREFIX of what replaces it, never true going from longer to shorter), so the version
  // row holds a full copy of the current content. Computed here in JS from columns the one row read
  // above already carries — no extra statement — the same margin the merge writer uses (1024 bytes).
  const contentIsFullCopy = contentChanged
    && !(restoredContent.startsWith(row.content) && !row.content.includes("\0") && !restoredContent.includes("\0"));
  const projectedStateBytes = utf8Bytes(JSON.stringify({ when_at: row.when_at, when_kind: row.when_kind, when_source: row.when_source, when_label: row.when_label }));
  const metaCandidate = {
    nonce, target_seq: target.seq, reverted_reason: target.reason,
    ...(restoreWhen ? { when: true } : {}),
    ...(recreatedForMeta.length ? { recreated_incoming: recreatedForMeta } : {}),
  };
  const projectedRowBytes = (contentIsFullCopy ? row.content_bytes : 0) + row.tags_bytes + projectedStateBytes + utf8Bytes(JSON.stringify(metaCandidate)) + 1024;
  // recreated_incoming looks like the row's one optional part, the way meta.incoming is optional for
  // the merge writer's own row — but dropping it is not a safe fallback here (U19): a merge's incoming
  // is re-created at most once ever, and that promise is kept entirely by this record. A row that lost
  // it here would let a later rollback past the same merge re-create it a second time, permanently.
  // Unlike the merge writer's optional text, there is nothing else in this row safe to drop: content
  // is the row's own required history (shrinking it would corrupt reconstruction), so an oversized
  // full copy is only ever logged, the same residual risk the spec already accepts for a row that
  // grows past what a scoped read can predict.
  if (projectedRowBytes > VERSION_ROW_BUDGET_BYTES) console.error("Revert version row may exceed the row budget (non-fatal, nothing dropped):", { entryId: id, projectedRowBytes });

  let results;
  try {
    results = await env.DB.batch([
      snapshotStatement(env, {
        entryId: id, reason: "revert", change,
        content: contentChanged ? { kind: "next", content: restoredContent } : { kind: "unchanged" },
        nextTags: restoredTags, nextWhen, skipNoOp: false, expectNewestSeq: newest.seq, guard: workspaceGuard,
        // Recorded whenever this revert restores the date, so a later undo of THIS version (a redo)
        // knows to restore when_* too, the same way an append-with-when or a due version does (U2).
        // recreated_incoming carries only ids and which merge each belongs to (never content, never
        // owner fields) — enough to find a row again or tell a merge was already covered, at a
        // constant, tiny cost regardless of how large the fact itself is (U13).
        meta: metaCandidate, now,
      }),
      // versioning: snapshot
      env.DB.prepare(updateSql).bind(...p.values()),
      ...incomingStatements,
      pruneStatement(env, id, config.VERSION_KEEP),
    ]);
  } catch (e) {
    // The re-embed above already pointed the row's deterministic vector ids at the restored text; a
    // thrown batch means the row itself never committed, so the index and the row would disagree
    // until the next write touched it. Re-embed from the row as it actually stands (U6) — never
    // delete under those ids, which are the row's live vectors (the rule ADV proved broken elsewhere).
    if (needsReembed) await restoreRowVectors(env, id, oldVectorIds, newVectorIds ?? [], row.source, config, embedCtx);
    // The incoming rows never landed either (same batch, same guard, and now nothing to undo — the
    // INSERTs are gone with the rest of the transaction). Their vectors are fresh, deterministic ids
    // under no row, not a live row's own, so cleaning them up here breaks no rule (U18).
    for (const ins of incomingInserts) { if (ins.vectorIds.length) { try { await deleteVectorIds(env, ins.vectorIds); } catch (e2) { console.error("Orphan vector cleanup failed (non-fatal):", e2); } } }
    throw e;
  }

  if (changesOf(results[1]) === 0) {
    // The existence read comes first (U12): if it throws, nothing below has run and the row still
    // names whatever committed its own vectors, never something this lost attempt already deleted.
    // scope-exempt: by-id: the row was read above under the caller's own scope
    const stillThere = await env.DB.prepare(`SELECT 1 AS ok FROM entries WHERE id = ?`).bind(id).first();
    if (!stillThere) {
      // The row is truly gone: the fresh vectors this undo wrote describe a row nothing owns now.
      if (newVectorIds) { try { await deleteVectorIds(env, newVectorIds); } catch (e) { console.error("Orphan vector cleanup failed (non-fatal):", e); } }
      // The incoming inserts share the UPDATE's own guard, so they missed too: nothing landed for
      // them either, and their fresh vectors are equally orphaned.
      for (const ins of incomingInserts) { if (ins.vectorIds.length) { try { await deleteVectorIds(env, ins.vectorIds); } catch (e) { console.error("Orphan vector cleanup failed (non-fatal):", e); } } }
      return { status: "not_found" };
    }
    // The row is still there, committed by someone else. Never delete under the deterministic ids
    // this undo re-embedded onto (the class rule R2-2 proved broken elsewhere): re-embed from the row
    // as it actually stands instead, which restoreRowVectors does under those same ids.
    if (needsReembed) await restoreRowVectors(env, id, oldVectorIds, newVectorIds ?? [], row.source, config, embedCtx);
    // Same shared guard, same miss: the incoming inserts landed nowhere, so their vectors are orphans.
    for (const ins of incomingInserts) { if (ins.vectorIds.length) { try { await deleteVectorIds(env, ins.vectorIds); } catch (e) { console.error("Orphan vector cleanup failed (non-fatal):", e); } } }
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
  // rollback crosses, not only when a merge is the newest change (U4, U10). Reaching this point means
  // the batch above landed, so every incoming insert landed with it (same guard, same transaction):
  // only the audits, which are fire-and-forget by contract anyway, remain to be written here (U18).
  if (anyIncomingTruncated) (result as { incomingTruncated?: true }).incomingTruncated = true;
  if (incomingInserts.length) {
    const createdEvents = incomingInserts.map(ins => ({
      entryId: ins.id, actorId: change.actorId, event: "created" as const,
      // The undoer performs the recreation, so the undoer is credited and the undo's own channel
      // rides along, the same as every other audit this function writes (U17).
      payload: { cause: "undo_merge", from: id, channel: change.channel },
    }));
    await writeAuditEvents(env, createdEvents);
    (result as { recreatedIncomingId?: string }).recreatedIncomingId = incomingInserts[0].id;
  }
  if (keptIncoming.length) (result as { keptIncoming?: { id: string; reason: string }[] }).keptIncoming = keptIncoming;

  return result;
}
