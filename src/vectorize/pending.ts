import type { Env } from "../env";
import type { Config } from "../config";
import { MIRRORED_SOURCES } from "../constants";
import { graceMs } from "../lib/ai";
import { storeEntry, upsertEntryVectors, restoreRowVectors } from "../capture/store";
import { changedRows } from "../memory/trash";
import { INDEXABLE_SQL } from "../capture/lifecycle";
import { chunkText } from "../text/chunk";

/**
 * Deferred rows: vector_ids = '[]' past the grace window, not deprecated. POST /vectorize-pending
 * indexes them on demand; the nightly cron indexes a few per night so none waits on a caller.
 */
export const PENDING_WHERE = `vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL}`;

/** Nightly budget (free plan: 1,000 Cloudflare-service subrequests per invocation, 10,000 neurons a
 * day). At most 10 rows and 50 embed calls: about 70 subrequests and well under 100 neurons a night. */
export const VECTORIZE_PENDING_NIGHTLY_ROWS = 10;
export const VECTORIZE_PENDING_NIGHTLY_EMBEDS = 50;
/** Longer rows (over 20 chunks at worst) are left to POST /vectorize-pending, so one row always fits
 * the embed budget and a huge one never blocks the rows behind it. Mirrored rows embed one chunk. */
export const VECTORIZE_PENDING_NIGHTLY_MAX_CHARS = 12_000;

export interface PendingRow {
  id: string; content: string; tags: string; source: string; created_at: number; workspace_id: string; actor_id: string;
}

/** Index one deferred row under its own workspace and author (never the caller's). */
export async function indexPendingRow(env: Env, row: PendingRow, cfg: Readonly<Config>): Promise<void> {
  await storeEntry(env, row.id, row.content, JSON.parse(row.tags), row.source, row.created_at, cfg,
    { workspaceId: row.workspace_id, actorId: row.actor_id });
}

/** Chunks storeEntry will embed for this row (mirrored sources index the first chunk only). */
function embedCount(row: PendingRow): number {
  return MIRRORED_SOURCES.has(row.source) ? 1 : chunkText(row.content).length;
}

/**
 * The nightly pass: oldest deferred rows first, inside the row and embed budget; the rest wait a
 * night. The vector_ids writes go in ONE batch (the same content CAS storeEntry uses), so its D1
 * cost is a read plus a batch however many rows it indexes. Config is resolved only when there is work.
 */
export async function runNightlyVectorizePending(
  env: Env, cfg: Readonly<Config> | (() => Promise<Readonly<Config>>),
): Promise<{ processed: number; failed: number }> {
  const mirrored = [...MIRRORED_SOURCES];
  const { results } = await env.DB.prepare(
    // scope-exempt: deployment-wide maintenance; each row is indexed under its own workspace
    `SELECT id, content, tags, source, created_at, workspace_id, actor_id FROM entries
      WHERE ${PENDING_WHERE}
        AND (length(content) <= ? OR source IN (${mirrored.map(() => "?").join(", ")}))
      ORDER BY created_at ASC LIMIT ?`,
  ).bind(Date.now() - graceMs(env), VECTORIZE_PENDING_NIGHTLY_MAX_CHARS, ...mirrored, VECTORIZE_PENDING_NIGHTLY_ROWS).all<PendingRow>();
  if (!results.length) return { processed: 0, failed: 0 };
  const config = typeof cfg === "function" ? await cfg() : cfg;

  let failed = 0;
  let embeds = 0;
  const upserted: { row: PendingRow; vectorIds: string[] }[] = [];
  for (const row of results) {
    const cost = embedCount(row);
    if (embeds + cost > VECTORIZE_PENDING_NIGHTLY_EMBEDS) break;
    embeds += cost;
    try {
      const stored = await upsertEntryVectors(env, row.id, row.content, JSON.parse(row.tags), row.source, row.created_at, config,
        { workspaceId: row.workspace_id, actorId: row.actor_id });
      upserted.push({ row, vectorIds: stored.vectorIds });
    } catch (e) {
      console.error("Nightly re-embed failed for entry", row.id, e);
      failed++;
    }
  }
  if (!upserted.length) return { processed: 0, failed };

  const written = await env.DB.batch(upserted.map(({ row, vectorIds }) => env.DB.prepare(
    // versioning: exempt: vector bookkeeping
    `UPDATE entries SET vector_ids = ? WHERE id = ? AND content = ?`,
  ).bind(JSON.stringify(vectorIds), row.id, row.content)));
  let processed = 0;
  for (let i = 0; i < upserted.length; i++) {
    if (changedRows(written[i]) > 0) { processed++; continue; }
    // Lost the content CAS to a concurrent edit: re-embed the row as it stands now (storeEntry's rule).
    const { row, vectorIds } = upserted[i];
    try {
      await restoreRowVectors(env, row.id, [], vectorIds, row.source, config, { workspaceId: row.workspace_id, actorId: row.actor_id });
    } catch (e) {
      console.error("Nightly re-embed repair failed for entry", row.id, e);
    }
  }
  return { processed, failed };
}
