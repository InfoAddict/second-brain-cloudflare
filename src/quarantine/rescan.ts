// Codex review classes C and D (T-0089.4.2, reversing the earlier 5.1 point 2 acceptance,
// 16-t3-t4-trust-spec.md 5.1 "Scorer byte budget", point 2): a write over 32 KB is scored on its
// head and tail only (normalize.ts's budgetSlice). It is held out of recall — reason
// `pending-scan` — from the moment it is written, not stored unheld with a marker, and stays
// held until the nightly pass has scored every part of it. This module is that pass: it scores
// the unscanned middle in bounded chunks, across as many nights as it takes, recording progress
// on the row itself so a slow corpus or a crash never loses ground. It runs inside the EXISTING
// nightly cron (src/index.ts's "nightly maintenance" job), never on a trigger of its own.
import type { Env } from "../env";
import type { Config } from "../config";
import { scoreWrite, type QuarantineChannel } from "./score";
import { QUARANTINE_SCORE_HEAD_CHARS, QUARANTINE_SCORE_TAIL_CHARS, QUARANTINE_SCORE_CHARS } from "./normalize";
import { heldTagsFor, holdStatements } from "./hold";
import {
  QUARANTINE_TAG_PREFIX, heldReason, scannedProgress, withScanProgress, withoutScanProgress,
} from "./tags";
import { MIRRORED_SOURCES } from "../constants";
import { discardUpload, upsertEntryVectors } from "../capture/store";
import { deleteEntryVectors } from "../vectorize/batch";
import { getStatus, withStatus } from "../memory/status";
import {
  buildCasGuard, changesOf, loadHistory, Params, pruneStatement, snapshotStatement, type VersionRow,
} from "../memory/versions";
import { auditEvent } from "../lib/audit";

/** Rows scanned per nightly run: a few is enough to drain any realistic backlog (a >32 KB write
 * needing this pass is rare) while keeping the pass a small, fixed addition to the nightly
 * invocation's own D1 and CPU budget. */
export const QUARANTINE_RESCAN_PER_NIGHT = 10;

interface RescanRow { id: string; content: string; tags: string; source: string; workspace_id: string; vector_ids: string }

/** The channel a stored row's write would have used, for the rescan's own scorer input — the
 * strictest defensible guess when the original channel (mcp vs rest) was never recorded on the
 * row itself: a mirrored source is always system:mirror; everything else is scored as mcp,
 * never rest, so this pass never scores MORE leniently than the write that produced the row. */
function channelFor(source: string): QuarantineChannel {
  return MIRRORED_SOURCES.has(source) ? "system:mirror" : "mcp";
}

const RESCAN_CHANGE = { actorId: "", channel: "system:quarantine-rescan" as const };

/** A `reason: "status"` version whose meta records a hold — the one this pending-scan streak
 * started from, so its recorded tags are the requested (pre-hold) state, status included, to
 * restore on release. Same check as undo.ts's own isHoldVersion; kept local rather than shared
 * since it is three lines and the two modules should not otherwise depend on each other. */
function isHoldVersion(v: Pick<VersionRow, "reason" | "meta">): boolean {
  if (v.reason !== "status") return false;
  try { return !!(JSON.parse(v.meta || "{}") as Record<string, unknown>).hold; } catch { return false; }
}

/** The row's requested tags with every quarantine bookkeeping tag (the hold itself, and the scan
 * progress cursor) stripped — never the historical hold-version tags, so any edit made to the row
 * while it was held (D4.1) is kept. */
function requestedTagsOf(currentTags: readonly string[]): string[] {
  return withoutScanProgress(currentTags).filter(t => !t.trim().toLowerCase().startsWith(QUARANTINE_TAG_PREFIX));
}

/**
 * One bounded pass: for each queued row, scores the next unscanned chunk of its middle. `ctx` is
 * the caller's own ExecutionContext — used only for the fire-and-forget audit writes; the pass
 * itself is fully awaited by the caller (the nightly job).
 */
export async function runQuarantineRescan(
  env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }, cfg: Readonly<Config>, limit: number = QUARANTINE_RESCAN_PER_NIGHT,
): Promise<{ scanned: number; held: number; released: number }> {
  const { results } = await env.DB.prepare(
    // scope-exempt: cron: nightly maintenance, corpus-wide by design like every other pass in this job
    // validity: any: a hold decision does not depend on whether the fact is currently valid — a
    // row past its valid_until still owes its unscanned middle a check before it can surface again
    // Budget auditor R19: matches idx_entries_quarantine_pending_scan's own WHERE expression
    // verbatim (the ledger index's pattern), so the planner uses it instead of a full table scan.
    `SELECT id, content, tags, source, workspace_id, vector_ids FROM entries
     WHERE instr(lower(tags), '"${QUARANTINE_TAG_PREFIX}pending-scan"') > 0 LIMIT ?`,
  ).bind(limit).all<RescanRow>();
  const rows = results ?? [];

  let held = 0;
  let released = 0;
  for (const row of rows) {
    try {
      const outcome = await rescanOne(env, ctx, cfg, row);
      if (outcome === "held") held++;
      if (outcome === "released") released++;
    } catch (e) {
      console.error("Quarantine rescan failed for one row (non-fatal, retried next night):", e);
    }
  }
  return { scanned: rows.length, held, released };
}

async function rescanOne(
  env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }, cfg: Readonly<Config>, row: RescanRow,
): Promise<"held" | "released" | "advanced" | "skipped"> {
  const currentTags: string[] = JSON.parse(row.tags ?? "[]");
  // Defensive: the candidate read and this call can straddle a concurrent change (a manual
  // release via undo, an edit). Not still pending-scan: leave it alone, the next candidate read
  // will not pick it up again either.
  if (heldReason(currentTags) !== "pending-scan") return "skipped";

  // Codex review class C (T-0089.4.2): guarded on everything this call read — content, tags AND
  // vector_ids — so a write that landed after this read (a concurrent edit, or a fresh Vectorize
  // upload) is never clobbered. Any miss below means "something changed since the read": this
  // row is left exactly as it now stands, for the next pass to re-read fresh and retry.
  const casColumns = { content: row.content, tags: row.tags, workspace_id: row.workspace_id, vector_ids: row.vector_ids ?? null };
  const requestedTags = requestedTagsOf(currentTags);
  const progress = scannedProgress(currentTags) ?? QUARANTINE_SCORE_HEAD_CHARS;
  const middleEnd = row.content.length - QUARANTINE_SCORE_TAIL_CHARS;
  const now = Date.now();

  if (progress < middleEnd) {
    // Class D (budget auditor): a bounded chunk, never the whole middle in one pass — a note
    // between 64 KB and 128 KB needs several nights, each chunk within the same ~9 ms budget the
    // write-time scorer's own 32 KB cap was measured at.
    const chunkEnd = Math.min(progress + QUARANTINE_SCORE_CHARS, middleEnd);
    const score = scoreWrite(
      { content: row.content.slice(progress, chunkEnd), tags: requestedTags, source: row.source, channel: channelFor(row.source), kind: "update" },
      cfg,
    );

    if (score.hold) {
      // This chunk alone crosses the threshold: upgrade from pending-scan to the real reason, in
      // place — the row was already held, so vector_ids is already '[]' and stays that way.
      const heldTags = withoutScanProgress(heldTagsFor(requestedTags, score.reasons));
      const p = new Params();
      const tagsIdx = p.add(JSON.stringify(heldTags));
      const idIdx = p.add(row.id);
      const results = await env.DB.batch([
        snapshotStatement(env, {
          entryId: row.id, reason: "status", change: RESCAN_CHANGE, content: { kind: "unchanged" }, nextTags: heldTags,
          meta: { hold: { reasons: score.reasons, score: score.score, signals: score.signals.map(s => s.id) } }, now,
          guard: p2 => buildCasGuard(p2, casColumns),
        }),
        // versioning: snapshot — the snapshot above rides in the same batch, under the same guard
        env.DB.prepare(`UPDATE entries AS e SET tags = ${tagsIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values()),
        pruneStatement(env, row.id, cfg.VERSION_KEEP),
      ]);
      if (changesOf(results[1]) === 0) return "skipped";
      auditEvent(env, ctx, {
        entryId: row.id, actorId: "", event: "held",
        payload: { reasons: score.reasons, score: score.score, channel: "system:quarantine-rescan" },
      });
      return "held";
    }

    if (chunkEnd < middleEnd) {
      // Not done yet: advance the cursor only. Internal bookkeeping, not a user-visible change —
      // no version, same treatment as every other pipeline-marker write in this codebase.
      const nextTags = withScanProgress(currentTags, chunkEnd);
      const p = new Params();
      const tagsIdx = p.add(JSON.stringify(nextTags));
      const idIdx = p.add(row.id);
      // versioning: exempt: internal bookkeeping — advances the scan cursor, not a user-visible change
      const result = await env.DB.prepare(`UPDATE entries AS e SET tags = ${tagsIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`)
        .bind(...p.values()).run();
      return changesOf(result) === 0 ? "skipped" : "advanced";
    }
    // chunkEnd reached middleEnd: the whole note has now been scanned clean. Falls through to release.
  }

  return completeScan(env, ctx, cfg, row, currentTags, requestedTags, casColumns, now);
}

/**
 * The whole note has been scanned clean (or, defensively, had nothing left to scan — a content
 * edit while held could shrink it below its own progress cursor): release, restoring the status
 * the write originally requested. Codex review class A (T-0089.4.2): commits the unheld state
 * only AFTER the re-embed succeeds; any failure — Vectorize outage included — leaves the row held
 * for the next pass to retry, never releases it unindexed.
 */
async function completeScan(
  env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }, cfg: Readonly<Config>, row: RescanRow,
  currentTags: string[], requestedTags: string[],
  casColumns: { content: string; tags: string; workspace_id: string; vector_ids: string | null },
  now: number,
): Promise<"released" | "skipped"> {
  // The hold version recorded the PRIOR (pre-hold) tags — including the status the write
  // originally requested, which withHold's status:draft override replaced on the live row.
  const chain = await loadHistory(env, undefined, { id: row.id, content: row.content }, cfg.VERSION_KEEP);
  const holdVersion = chain.rows.find(isHoldVersion);
  const priorStatus = holdVersion ? getStatus(JSON.parse(holdVersion.tags)) : null;
  const releasedTags = (getStatus(currentTags) === "draft" && priorStatus)
    ? withStatus(requestedTags, priorStatus)
    : requestedTags;

  let newVectorIds: string[];
  try {
    // Held tags never reach upsertEntryVectors's own gate (class A): releasedTags carries none.
    const stored = await upsertEntryVectors(env, row.id, row.content, releasedTags, row.source, now, cfg, { workspaceId: row.workspace_id, actorId: "" });
    newVectorIds = stored.vectorIds;
  } catch (e) {
    console.error("Quarantine rescan release re-embed failed (non-fatal, retried next night):", e);
    return "skipped";
  }

  const p = new Params();
  const tagsIdx = p.add(JSON.stringify(releasedTags));
  const vecIdx = p.add(JSON.stringify(newVectorIds));
  const idIdx = p.add(row.id);
  let results;
  try {
    results = await env.DB.batch([
      snapshotStatement(env, {
        entryId: row.id, reason: "status", change: RESCAN_CHANGE, content: { kind: "unchanged" }, nextTags: releasedTags,
        meta: { release: { auto: true } }, now,
        guard: p2 => buildCasGuard(p2, casColumns),
      }),
      // versioning: snapshot — the snapshot above rides in the same batch, under the same guard
      env.DB.prepare(`UPDATE entries AS e SET tags = ${tagsIdx}, vector_ids = ${vecIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`)
        .bind(...p.values()),
      pruneStatement(env, row.id, cfg.VERSION_KEEP),
    ]);
  } catch (e) {
    await discardUpload(env, row.id, newVectorIds);
    throw e;
  }
  if (changesOf(results[1]) === 0) {
    await discardUpload(env, row.id, newVectorIds);
    return "skipped";
  }

  const oldVectorIds: string[] = JSON.parse(casColumns.vector_ids ?? "[]");
  if (oldVectorIds.length) {
    try { await deleteEntryVectors(env, [{ entryId: row.id, vectorIds: oldVectorIds }]); } catch (e) { console.error("Vectorize delete failed after a quarantine rescan release (non-fatal):", e); }
  }

  auditEvent(env, ctx, {
    entryId: row.id, actorId: "", event: "released",
    payload: { channel: "system:quarantine-rescan" },
  });
  return "released";
}
