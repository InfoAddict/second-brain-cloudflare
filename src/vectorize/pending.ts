import type { Env } from "../env";
import type { Config } from "../config";
import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS, MIRRORED_SOURCES } from "../constants";
import { graceMs } from "../lib/ai";
import { storeEntry, upsertEntryVectors, settleLostVectorCommit } from "../capture/store";
import { changedRows } from "../memory/trash";
import { INDEXABLE_SQL } from "../capture/lifecycle";

/**
 * Deferred rows: vector_ids = '[]' past the grace window, not deprecated. POST /vectorize-pending
 * indexes them on demand; the nightly cron indexes a few per night so none waits on a caller.
 */
export const PENDING_WHERE = `vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL}`;

/**
 * Nightly budget (free plan: 1,000 Cloudflare-service subrequests per invocation, 10,000 neurons a
 * day). Up to 10 rows sharing 250 embedded chunks, 100 chunks per AI call. The oldest row always gets
 * the night, all of it if it needs more than 250 chunks, so no row is ever skipped for its size. D1's
 * 2 MB row cap bounds any row to about 3,400 chunks: 34 AI calls and 4 Vectorize upserts.
 * Neurons (bge-small, about 1,840 per M input tokens): a full 250-chunk night is under 100k tokens,
 * about 185 neurons; a 128 KB note is about 40k tokens, about 75 neurons.
 */
export const VECTORIZE_PENDING_NIGHTLY_ROWS = 10;
export const VECTORIZE_PENDING_NIGHTLY_EMBEDS = 250;

export interface PendingRow {
  id: string; content: string; tags: string; source: string; created_at: number; workspace_id: string; actor_id: string;
}

/** Index one deferred row under its own workspace and author (never the caller's). False when the
 * row's content or workspace changed during the embed: the upload is settled and the row stays pending. */
export async function indexPendingRow(env: Env, row: PendingRow, cfg: Readonly<Config>): Promise<boolean> {
  const stored = await storeEntry(env, row.id, row.content, JSON.parse(row.tags), row.source, row.created_at, cfg,
    { workspaceId: row.workspace_id, actorId: row.actor_id });
  return stored.committed !== false;
}

/** An upper bound on the chunks chunkText makes from `len` characters, worst case (a sentence break
 * just past the half-way mark each time, so each chunk advances only CHUNK_MAX_CHARS / 2 - overlap). */
function chunkBound(len: number, source: string): number {
  if (MIRRORED_SOURCES.has(source) || len <= CHUNK_MAX_CHARS) return 1;
  return 2 + Math.ceil((len - CHUNK_MAX_CHARS) / (CHUNK_MAX_CHARS / 2 - CHUNK_OVERLAP_CHARS));
}

/**
 * The nightly pass. Plans from lengths alone (no content read yet): the oldest deferred row always
 * goes, then more rows oldest first while they fit the chunk budget; the first that does not fit
 * ends the night and heads the next one, so nothing behind it overtakes it. Only the chosen rows'
 * content is read. Chunks are embedded 100 per AI call, and the vector_ids writes go in ONE batch
 * (the same content CAS storeEntry uses). Config is resolved only when there is work.
 */
export async function runNightlyVectorizePending(
  env: Env, cfg: Readonly<Config> | (() => Promise<Readonly<Config>>),
): Promise<{ processed: number; failed: number }> {
  const { results: queue } = await env.DB.prepare(
    // scope-exempt: deployment-wide maintenance; each row is indexed under its own workspace
    `SELECT id, length(content) AS len, source FROM entries WHERE ${PENDING_WHERE} ORDER BY created_at ASC, id LIMIT ?`,
  ).bind(Date.now() - graceMs(env), VECTORIZE_PENDING_NIGHTLY_ROWS).all<{ id: string; len: number; source: string }>();
  if (!queue.length) return { processed: 0, failed: 0 };

  const chosen: string[] = [];
  let planned = 0;
  for (const q of queue) {
    const cost = chunkBound(q.len, q.source);
    if (chosen.length > 0 && planned + cost > VECTORIZE_PENDING_NIGHTLY_EMBEDS) break;
    chosen.push(q.id);
    planned += cost;
  }
  const config = typeof cfg === "function" ? await cfg() : cfg;
  const { results: loaded } = await env.DB.prepare(
    // scope-exempt: by-id: the rows this maintenance pass just chose, each indexed under its own workspace
    `SELECT id, content, tags, source, created_at, workspace_id, actor_id FROM entries WHERE id IN (SELECT value FROM json_each(?)) AND ${PENDING_WHERE}`,
  ).bind(JSON.stringify(chosen), Date.now() - graceMs(env)).all<PendingRow>();
  const rows = chosen.map(id => loaded.find(r => r.id === id)).filter((r): r is PendingRow => !!r);

  let failed = 0;
  const upserted: { row: PendingRow; vectorIds: string[] }[] = [];
  for (const row of rows) {
    try {
      const stored = await upsertEntryVectors(env, row.id, row.content, JSON.parse(row.tags), row.source, row.created_at, config,
        { workspaceId: row.workspace_id, actorId: row.actor_id }, { batchEmbeds: true });
      upserted.push({ row, vectorIds: stored.vectorIds });
    } catch (e) {
      console.error("Nightly re-embed failed for entry", row.id, e);
      failed++;
    }
  }
  if (!upserted.length) return { processed: 0, failed };
  // CAS on the content AND the workspace the vectors were stamped for (round 5): a share or move
  // during the embed misses, and the upload is settled below instead of committed.
  const written = await env.DB.batch(upserted.map(({ row, vectorIds }) => env.DB.prepare(
    // versioning: exempt: vector bookkeeping
    `UPDATE entries SET vector_ids = ? WHERE id = ? AND content = ? AND workspace_id = ?`,
  ).bind(JSON.stringify(vectorIds), row.id, row.content, row.workspace_id)));
  let processed = 0;
  for (let i = 0; i < upserted.length; i++) {
    if (changedRows(written[i]) > 0) { processed++; continue; }
    // Lost the CAS (content edited, or the row shared or moved): delete the stale upload and leave
    // the row pending for next night, or repair it if another writer has committed meanwhile.
    const { row, vectorIds } = upserted[i];
    try {
      await settleLostVectorCommit(env, row.id, vectorIds, row.source, config, { workspaceId: row.workspace_id, actorId: row.actor_id });
    } catch (e) {
      console.error("Nightly re-embed settle failed for entry", row.id, e);
    }
  }
  return { processed, failed };
}
