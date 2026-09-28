// Lane W follow-up (16-t3-t4-trust-spec.md 5.1 "Scorer byte budget", point 2): a write over
// 32 KB is scored on its head and tail only (normalize.ts's budgetSlice), so an injection
// hidden in the middle escapes inline scoring. Every write path that can produce a `partial`
// score tags the row NEEDS_RESCAN_TAG (never a `quarantine:` tag, so it stays unheld and
// indexable) instead of silently accepting the gap. This module is the bounded background pass
// that closes it: it runs inside the EXISTING nightly cron (src/index.ts's "nightly maintenance"
// job), never on a trigger of its own.
import type { Env } from "../env";
import type { Config } from "../config";
import { scoreWrite, type QuarantineChannel } from "./score";
import { QUARANTINE_SCORE_HEAD_CHARS, QUARANTINE_SCORE_TAIL_CHARS } from "./normalize";
import { heldTagsFor, holdStatements } from "./hold";
import { NEEDS_RESCAN_TAG, withoutNeedsRescan } from "./tags";
import { MIRRORED_SOURCES } from "../constants";
import { deleteEntryVectors } from "../vectorize/batch";
import { buildCasGuard, changesOf, Params, pruneStatement, snapshotStatement } from "../memory/versions";
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

/**
 * One bounded pass: scores the previously-unscanned middle of each queued row, holds it if that
 * middle alone crosses the threshold, and otherwise just clears the marker. `ctx.waitUntil` is
 * never used here — the caller (the nightly job) already awaits this whole pass.
 */
export async function runQuarantineRescan(
  env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }, cfg: Readonly<Config>, limit: number = QUARANTINE_RESCAN_PER_NIGHT,
): Promise<{ scanned: number; held: number }> {
  const { results } = await env.DB.prepare(
    // scope-exempt: cron: nightly maintenance, corpus-wide by design like every other pass in this job
    `SELECT id, content, tags, source, workspace_id, vector_ids FROM entries WHERE tags LIKE ? LIMIT ?`,
  ).bind(`%"${NEEDS_RESCAN_TAG}"%`, limit).all<RescanRow>();
  const rows = results ?? [];

  let held = 0;
  for (const row of rows) {
    try {
      if (await rescanOne(env, ctx, cfg, row)) held++;
    } catch (e) {
      console.error("Quarantine rescan failed for one row (non-fatal, retried next night):", e);
    }
  }
  return { scanned: rows.length, held };
}

async function rescanOne(env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }, cfg: Readonly<Config>, row: RescanRow): Promise<boolean> {
  const tags: string[] = JSON.parse(row.tags ?? "[]");
  const requestedTags = withoutNeedsRescan(tags);

  // The content may since have been edited down below the budget (a later update replaces the
  // whole row, tags included, so this branch is defensive, not the common case): nothing left to
  // scan, just clear the marker.
  const middleStart = QUARANTINE_SCORE_HEAD_CHARS;
  const middleEnd = row.content.length - QUARANTINE_SCORE_TAIL_CHARS;
  const now = Date.now();
  const channel = channelFor(row.source);
  const change = { actorId: "", channel: `system:quarantine-rescan` as const };

  if (middleEnd <= middleStart) {
    await clearMarker(env, row, requestedTags);
    return false;
  }

  const middle = row.content.slice(middleStart, middleEnd);
  const score = scoreWrite({ content: middle, tags: requestedTags, source: row.source, channel, kind: "update" }, cfg);

  if (!score.hold) {
    await clearMarker(env, row, requestedTags);
    return false;
  }

  const heldTags = heldTagsFor(requestedTags, score.reasons);
  const casColumns = { tags: row.tags, workspace_id: row.workspace_id, vector_ids: row.vector_ids ?? null };
  const batch = [
    // The row's requested (non-quarantine) tags become the recorded prior state, same shape as
    // every other hold: the caller asked for `requestedTags`, and quarantine is what happened to it.
    snapshotStatement(env, {
      entryId: row.id, reason: "status", change, content: { kind: "unchanged" }, nextTags: requestedTags,
      meta: { rescan: true }, now,
      guard: p => buildCasGuard(p, casColumns),
    }),
    ...holdStatements(env, { snapshotStatement, pruneStatement, versionKeep: cfg.VERSION_KEEP }, {
      entryId: row.id, reasons: score.reasons, score: score.score, signals: score.signals, change, heldTags, now,
      guard: p => `tags = ${p.add(row.tags)} AND workspace_id = ${p.add(row.workspace_id)}`,
    }),
  ];
  const results = await env.DB.batch(batch);
  if (changesOf(results[1]) === 0) return false; // lost a race with another write; next night retries

  const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
  if (oldVectorIds.length) {
    try {
      await deleteEntryVectors(env, [{ entryId: row.id, vectorIds: oldVectorIds }]);
    } catch (e) {
      console.error("Vectorize delete failed after a quarantine rescan hold (non-fatal):", e);
    }
  }
  auditEvent(env, ctx, {
    entryId: row.id, actorId: "", event: "held",
    payload: { reasons: score.reasons, score: score.score, channel: "system:quarantine-rescan" },
  });
  return true;
}

/** Removes NEEDS_RESCAN_TAG with no version: an internal bookkeeping clear, not a user-visible
 * change (the same "versioning: exempt: counters" treatment this codebase gives other
 * pipeline-only tag writes). */
async function clearMarker(env: Env, row: RescanRow, requestedTags: string[]): Promise<void> {
  const p = new Params();
  const tagsIdx = p.add(JSON.stringify(requestedTags));
  const idIdx = p.add(row.id);
  // versioning: exempt: internal bookkeeping — clears a pipeline marker, not a user-visible change
  await env.DB.prepare(`UPDATE entries SET tags = ${tagsIdx} WHERE id = ${idIdx} AND tags = ${p.add(row.tags)}`)
    .bind(...p.values()).run();
}
