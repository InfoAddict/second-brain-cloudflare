import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { CHUNK_MAX_CHARS } from "../constants";
import { embed } from "../lib/ai";
import { inferEdgesOnWrite } from "../graph/edges";
import { neighborsFromVectorQuery } from "../graph/traverse";
import { chunkText } from "../text/chunk";
import { isVectorizeUnavailable } from "../vectorize/health";
import { tagsAfterWrite } from "../memory/stale";

export async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number,
  config: Readonly<Config> = DEFAULTS
): Promise<string[]> {
  const chunks = chunkText(content);

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      const metadata: Record<string, any> = {
        content: chunk,
        parentId: id,
        chunkIndex: i,
        totalChunks: chunks.length,
        tags,
        source,
        created_at: now,
      };

      tags.forEach(t => {
        metadata[`tag_${t.replace(/[."]/g, "_")}`] = true;
      });

      return {
        id: chunks.length === 1 ? id : `${id}-chunk-${i}`,
        values: await embed(chunk, env, config),
        metadata,
      };
    })
  );

  await env.VECTORIZE.upsert(vectors);

  const vectorIds = vectors.map(v => v.id);

  await env.DB.prepare(
    `UPDATE entries SET vector_ids = ? WHERE id = ?`
  ).bind(JSON.stringify(vectorIds), id).run();

  return vectorIds;
}

export async function deleteStaleVectors(env: Env, oldIds: string[], newIds: string[]): Promise<void> {
  if (!newIds.length) return;
  const stale = oldIds.filter(v => !newIds.includes(v));
  if (stale.length) await env.VECTORIZE.deleteByIds(stale);
}

export async function reembedOrThrow(env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config> = DEFAULTS): Promise<string[]> {
  const ids = await storeEntry(env, id, content, tags, source, Date.now(), config);
  if (!ids.length) throw new Error("re-embed produced no vectors");
  return ids;
}

/**
 * Re-embed for a content mutation. Returns the new vector ids, or null when
 * Vectorize is unreachable and the caller should commit the content keyword-only
 * (#270). Rethrows every other failure so #212's fail-loud contract survives:
 * a transient embed failure must not commit content against stale vectors.
 *
 * Callers that get null MUST NOT retire the old vectors — they are the entry's
 * only remaining semantic index until Vectorize returns.
 */
export async function reembedOrDegrade(env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config> = DEFAULTS): Promise<string[] | null> {
  try {
    return await reembedOrThrow(env, id, content, tags, source, config);
  } catch (e) {
    if (!(await isVectorizeUnavailable(env))) throw e;
    console.error("Vectorize unavailable — committing content without re-embedding:", e);
    return null;
  }
}

export async function appendToEntry(
  env: Env,
  id: string,
  existingContent: string,
  addition: string,
  tags: string[],
  source: string,
  config: Readonly<Config> = DEFAULTS
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  const existingVectorIds: string[] = JSON.parse(row?.vector_ids ?? "[]");

  const timestamp = new Date().toLocaleDateString();
  const separator = `\n\n[Update ${timestamp}]: `;
  const newContent = existingContent + separator + addition;

  if (newContent.length > CHUNK_MAX_CHARS) {
    const newVectorIds = await reembedOrDegrade(env, id, newContent, tags, source, config);
    const refreshedTags = tagsAfterWrite(tags);
    const now = Date.now();

    await env.DB.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ?`)
      .bind(newContent, JSON.stringify(refreshedTags), now, id).run();

    // Skipped when Vectorize is unavailable: the old vectors are the entry's only
    // remaining semantic index, and retiring them would leave it unsearchable.
    if (newVectorIds) {
      try {
        await deleteStaleVectors(env, existingVectorIds, newVectorIds);
      } catch (e) {
        console.error("Old vector cleanup failed (non-fatal):", e);
      }
    }

    try {
      await inferEdgesOnWrite(id, await neighborsFromVectorQuery(await embed(addition, env, config), env), env);
    } catch (e) {
      console.error("Append auto-link failed (non-fatal):", e);
    }

    return newVectorIds !== null;
  }

  const newChunkId = `${id}-update-${Date.now()}`;

  const values = await embed(addition, env, config);

  const metadata: Record<string, any> = {
    content: addition,
    parentId: id,
    isUpdate: true,
    tags,
    source,
    created_at: Date.now(),
  };

  tags.forEach(t => {
    metadata[`tag_${t.replace(/[."]/g, "_")}`] = true;
  });

  // Committed either way: keyword search reads entries.content, so an unindexed
  // addition is still recallable, whereas rejecting the append loses it outright.
  // A transient failure still throws — nothing is written yet, so the retry is safe.
  let indexed = true;
  try {
    await env.VECTORIZE.insert([{
      id: newChunkId,
      values,
      metadata,
    }]);
  } catch (e) {
    if (!(await isVectorizeUnavailable(env))) throw e;
    console.error("Vectorize unavailable — appending without indexing the addition:", e);
    indexed = false;
  }

  const refreshedTags = tagsAfterWrite(tags);
  const now = Date.now();

  await env.DB.prepare(
    `UPDATE entries SET content = ?, vector_ids = ?, tags = ?, updated_at = ? WHERE id = ?`
  ).bind(newContent, JSON.stringify(indexed ? [...existingVectorIds, newChunkId] : existingVectorIds), JSON.stringify(refreshedTags), now, id).run();

  try {
    await inferEdgesOnWrite(id, await neighborsFromVectorQuery(values, env), env);
  } catch (e) {
    console.error("Append auto-link failed (non-fatal):", e);
  }

  return indexed;
}
