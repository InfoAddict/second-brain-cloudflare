import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { CHUNK_MAX_CHARS, MIRRORED_SOURCES, VECTORIZE_UPSERT_BATCH, WRITE_CAS_ATTEMPTS } from "../constants";
import { embed } from "../lib/ai";
import { inferEdgesOnWrite } from "../graph/edges";
import { neighborsFromVectorQuery } from "../graph/traverse";
import { chunkText } from "../text/chunk";
import { deleteVectorIds } from "../vectorize/batch";
import { rememberTags } from "../tags/vocabulary";
import { applyTagReplacement, withUserEditMarker } from "../tags/system";
import { extractHashtags } from "../text/hashtags";
import { isVectorizeUnavailable } from "../vectorize/health";
import { tagsAfterWrite, tagsAfterAppend } from "../memory/stale";
import { withVolatility, type Volatility } from "../memory/volatility";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import type { ChangeContext } from "../lib/audit";
import { changesOf, pruneStatement, snapshotStatement, type WhenChange } from "../memory/versions";

/** Re-embedding must stamp vectors from the row being edited, not the caller's default write target. */
export function embedContextForRow(row: { workspace_id?: unknown }, writeCtx: WriteContext): WriteContext {
  return { workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : "", actorId: writeCtx.actorId };
}

/**
 * What a write left behind: the vector ids now on the row, and the vector of
 * its first chunk — the one a neighbour query should be run with.
 *
 * `values` is null only when there was nothing to embed.
 */
export interface StoredEntry {
  vectorIds: string[];
  values: number[] | null;
}

export async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number,
  config: Readonly<Config> = DEFAULTS,
  writeCtx: WriteContext = OWNER_WRITE_CONTEXT
): Promise<StoredEntry> {
  // A mirrored record is indexed by its first chunk only. `chunkText` splits at
  // CHUNK_MAX_CHARS and every chunk below gets its own vector, so a long one from
  // an external system produces vectors whose entire content is templated trailer
  // — navigation, legal and social boilerplate that repeats across every sender.
  // Those vectors carry no information but still match any query sharing one
  // ordinary word with them, which is how a payment receipt outranks a memory
  // about the thing you actually asked. The capture paths already lead with the
  // parts that identify the record (`buildEmailContent`, `buildEventContent`), so
  // the first chunk is where the signal is.
  //
  // Only the INDEX is truncated. entries.content keeps the whole record, so
  // nothing is lost to the reader and keyword search still covers all of it.
  const allChunks = chunkText(content);
  const chunks = MIRRORED_SOURCES.has(source) ? allChunks.slice(0, 1) : allChunks;

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
        // Which workspace this vector belongs to. User-facing queries filter on
        // it (with a graceful fallback — see src/vectorize/scope.ts); system
        // passes query unfiltered.
        workspace_id: writeCtx.workspaceId,
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

  // Vectorize accepts at most 1,000 vectors per upsert from a Worker.
  for (let i = 0; i < vectors.length; i += VECTORIZE_UPSERT_BATCH) await env.VECTORIZE.upsert(vectors.slice(i, i + VECTORIZE_UPSERT_BATCH));

  const vectorIds = vectors.map(v => v.id);

  // This UPDATE is the tail of a version write (fresh vectors for the row). It
  // deliberately does NOT touch workspace_id: an update edits a row in place and
  // must never move it between workspaces — that is share/unshare's job alone.
  // Restamping here would let any context-less caller silently reset a row to ''.
  // versioning: exempt: vector bookkeeping
  await env.DB.prepare(
    `UPDATE entries SET vector_ids = ? WHERE id = ?`
  ).bind(JSON.stringify(vectorIds), id).run();

  // The first chunk's vector rides back out with the ids. Callers that need to
  // ask "what is this entry near?" straight after writing it — the update path
  // below — would otherwise embed the very same text a second time, and an
  // embed is a neuron against a 10k/day budget.
  return { vectorIds, values: vectors[0]?.values ?? null };
}

export async function deleteStaleVectors(env: Env, oldIds: string[], newIds: string[]): Promise<void> {
  if (!newIds.length) return;
  const keep = new Set(newIds);
  const stale = oldIds.filter(v => !keep.has(v));
  if (stale.length) await deleteVectorIds(env, stale);
}

export async function reembedOrThrow(env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config> = DEFAULTS, writeCtx: WriteContext = OWNER_WRITE_CONTEXT): Promise<StoredEntry> {
  const stored = await storeEntry(env, id, content, tags, source, Date.now(), config, writeCtx);
  if (!stored.vectorIds.length) throw new Error("re-embed produced no vectors");
  return stored;
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
export async function reembedOrDegrade(env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config> = DEFAULTS, writeCtx: WriteContext = OWNER_WRITE_CONTEXT): Promise<StoredEntry | null> {
  try {
    return await reembedOrThrow(env, id, content, tags, source, config, writeCtx);
  } catch (e) {
    if (!(await isVectorizeUnavailable(env))) throw e;
    console.error("Vectorize unavailable — committing content without re-embedding:", e);
    return null;
  }
}

/**
 * A writer re-embedded a row and then lost the compare-and-set to a concurrent edit: the vectors under
 * that id now describe the loser's text. Re-embed the row as it stands now and retire any
 * extra chunks the merge wrote. Best effort: the edit itself is safe in D1 either way.
 */
export async function restoreRowVectors(
  env: Env, id: string, oldVectorIds: string[], mergedVectorIds: string[], source: string,
  cfg: Readonly<Config>, writeCtx: WriteContext,
): Promise<void> {
  try {
    const current = await env.DB.prepare(
      // scope-exempt: by-id: the merge target this call just read under the write's own workspace
      `SELECT content, tags, workspace_id FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;
    if (!current) {
      // Forgotten during the merge's re-embed: nothing owns the merge's vectors any more.
      await deleteVectorIds(env, [...new Set([...oldVectorIds, ...mergedVectorIds])]);
      return;
    }
    const restored = await reembedOrThrow(env, id, current.content as string, JSON.parse(current.tags ?? "[]"), source, cfg, embedContextForRow(current, writeCtx));
    await deleteStaleVectors(env, [...new Set([...oldVectorIds, ...mergedVectorIds])], restored.vectorIds);
  } catch (e) {
    console.error("Restoring vectors after a lost write failed (non-fatal):", e);
    // The row's vector_ids now names vectors holding the loser's text. Emptying them makes
    // /vectorize-pending re-index the row from its own content, and the vectors go best-effort.
    try {
      // versioning: exempt: vector bookkeeping (L5)
      await env.DB.prepare(
        // scope-exempt: by-id: the merge target this call just read under the write's own workspace
        `UPDATE entries SET vector_ids = '[]' WHERE id = ?`
      ).bind(id).run();
      await deleteVectorIds(env, [...new Set([...oldVectorIds, ...mergedVectorIds])]);
    } catch (e2) {
      console.error("Emptying vector_ids after a lost write failed (non-fatal):", e2);
    }
  }
}

/**
 * What `updateEntryContent` did, in the terms its callers have to answer in.
 *
 * `vectorIds: null` is the keyword-only degrade (#270) — the content committed but
 * Vectorize was unreachable, so the entry still carries its previous embedding.
 */
export type UpdateEntryResult =
  | { status: "not_found" }
  | { status: "reembed_failed" }
  /** The row kept changing under the write: nothing was committed and the vectors were restored to the row as it stands. */
  | { status: "conflict" }
  | { status: "updated"; vectorIds: string[] | null };

/**
 * Replace an entry's content outright, keeping D1, the tags and the vector index in step.
 *
 * `POST /update` and the MCP `update` tool both land here. They used to be two
 * implementations of the same thing, and the copy behind MCP — the one every assistant
 * client actually calls — silently missed every hardening the route gained (#289): it
 * committed content against stale vectors when an embed failed, never moved the entry's
 * updated_at, never reset the staleness tags, and never extracted hashtags. Anything that
 * decides what gets written lives in here now; the callers only shape the reply.
 * (updated_at is named bare above on purpose — test/unit/updated-at-coalesced.test.ts reads
 * every backtick-delimited span in src/ as SQL, comments included.)
 *
 * The one thing they still do for themselves is the managed-mirror guard, because
 * `integrations/mirror.ts` imports this module and the dependency must not run both ways.
 * That guard refuses before anything is written, so a drift there cannot corrupt a row —
 * unlike everything below, which is why everything below moved.
 */
export async function updateEntryContent(
  env: Env,
  id: string,
  newContent: string,
  config: Readonly<Config> = DEFAULTS,
  volatility: Volatility | undefined,
  /**
   * The user's tags for this entry, replacing the ones it has. `undefined` means
   * "leave them alone" and is what every caller but the editor passes; `[]` means
   * the user removed the last one. The two must stay distinguishable — collapsing
   * them would let any caller that omits tags wipe them.
   */
  replaceTags: string[] | undefined,
  writeCtx: WriteContext,
  change: ChangeContext,
): Promise<UpdateEntryResult> {
  // Same treatment captureEntry gives every stored memory, which is the point — but note it
  // flattens all whitespace, so a replacement does not preserve line breaks or code fences.
  // `appendToEntry` deliberately does not flatten; prefer append when the shape matters.
  const { cleanContent, hashtags } = extractHashtags(newContent);
  // Content that is nothing but hashtags cleans down to "", which would blank the entry —
  // keep it as written in that case and let the tags be extracted anyway.
  const finalContent = cleanContent || newContent;

  // The row this write embedded from. The commit compares-and-sets on it: a second writer that
  // committed (and upserted its own vectors under the same deterministic ids) in between must not be
  // overwritten in D1 while its vectors win in the index.
  let embeddedFrom: string | null = null;
  let reembedded: StoredEntry | null = null;
  let last: { row: Record<string, any>; vectorIds: string[]; embedCtx: WriteContext } | null = null;

  for (let attempt = 1; attempt <= WRITE_CAS_ATTEMPTS; attempt++) {
    // vector_ids has to be read before any mutation: storeEntry overwrites it, and the
    // cleanup below needs to know which vectors the entry had on the way in.
    const row = await env.DB.prepare(
      // scope-exempt: by-id: routes gate with getReadableEntry + assertCanEditContent
      `SELECT content, tags, source, vector_ids, workspace_id FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;

    if (!row) {
      // Forgotten meanwhile: its own vectors went with it, and any this write made are orphans.
      if (reembedded?.vectorIds.length) {
        try { await deleteVectorIds(env, reembedded.vectorIds); } catch (e) { console.error("Orphan vector cleanup failed (non-fatal):", e); }
      }
      return { status: "not_found" };
    }

    const readContent: string = row.content;
    const readTags: string = row.tags ?? "[]";
    const source = row.source as string;
    const embedCtx = embedContextForRow(row, writeCtx);
    const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
    const existingTags: string[] = JSON.parse(readTags);
    last = { row, vectorIds: oldVectorIds, embedCtx };

    // A caller-supplied verdict is applied after the strip, not before: tagsAfterWrite
    // removes every volatility tag, so applying it first would throw the value away.
    // A replacement starts from the tags the Worker owns rather than from every tag
    // the entry has, so removing "pricing" in the editor cannot also remove the
    // classifier's `kind:semantic`. Without a replacement this is the union it has
    // always been, which is why nothing could be removed before.
    const baseTags = replaceTags ? applyTagReplacement(existingTags, replaceTags) : existingTags;
    const strippedTags = tagsAfterWrite([...new Set([...baseTags, ...hashtags])]);
    const mergedTags = (volatility ? withVolatility(strippedTags, volatility) : strippedTags)
      // `rolled-up` is a claim about content that no longer exists: the nightly digest wrote
      // it in the same statement that appended a `[Digest: <id>]` marker to the body, and a
      // full replacement destroys that marker. Left in place it costs the corrected memory a
      // 0.4x recall penalty (recall/math.ts) and bars it from every future digest, burying
      // the only copy of the new fact. The same reasoning tagsAfterWrite applies to the
      // volatility/staleness verdicts, and the reason `append` must NOT strip it — an append
      // keeps the digested original inside the entry, so the digest still covers it.
      .filter(t => t !== "rolled-up");
    // A person's edit takes a digest or insight out of the system's hands, in this same UPDATE.
    const committedTags = withUserEditMarker(mergedTags);

    // Re-embed FIRST (#212): if it fails, leave the entry's content and vectors untouched and
    // surface an error, instead of committing new content and then deleting every vector —
    // which would leave the entry silently unsearchable. null means Vectorize is unreachable
    // (#270), not that this embed failed. A retry re-embeds only if the row's text changed (another
    // writer may have upserted over these ids); a tags-only change keeps the vectors already made.
    if (attempt === 1 || embeddedFrom !== readContent) {
      try {
        reembedded = await reembedOrDegrade(env, id, finalContent, mergedTags, source, config, embedCtx);
      } catch (e) {
        console.error("Re-embed failed — entry left unchanged:", e);
        return { status: "reembed_failed" };
      }
      embeddedFrom = readContent;
    }
    const newVectorIds = reembedded?.vectorIds ?? null;

    // Safe to commit: either the embed succeeded, or Vectorize is unavailable and the old
    // vectors are kept below rather than retired.
    // A replacement is a new logical version of the entry, but it stays IN PLACE:
    // workspace_id is never touched here (share/unshare moves rows, nothing else does),
    // and actor_id is left untouched: the original author of a row being edited is not
    // this call's to decide.
    // The prior state is kept in the same batch as the change, and a lost attempt writes neither.
    const now = Date.now();
    const committed = await env.DB.batch([
      snapshotStatement(env, {
        entryId: id, reason: "update", change, content: { kind: "next", content: finalContent }, nextTags: committedTags, now,
        guard: p => `e.content = ${p.add(readContent)} AND e.tags = ${p.add(readTags)}`,
      }),
      // versioning: snapshot
      env.DB.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ? AND content = ? AND tags = ?`)
        .bind(finalContent, JSON.stringify(committedTags), now, id, readContent, readTags),
      pruneStatement(env, id, config.VERSION_KEEP),
    ]);
    if (changesOf(committed[1]) === 0) continue;

    // Rewritten content can carry hashtags the brain has never seen, so this is one of the
    // two places an unknown tag enters the corpus (#288). It sits here rather than in the
    // route because #289 made this the single update path — putting it in the caller would
    // have left the MCP tool introducing tags the cache never learned about.
    await rememberTags(env, mergedTags, embedCtx.workspaceId);

    if (newVectorIds) {
      try {
        await deleteStaleVectors(env, oldVectorIds, newVectorIds);
      } catch (e) {
        console.error("Old vector cleanup failed (non-fatal):", e);
      }
    }

    // An edit changes what the entry means, so it changes where the entry belongs
    // in the graph. Run on the vector the re-embed above already produced, so this
    // costs one Vectorize query and no second embed.
    //
    // Skipped on the keyword-only degrade (#270): with no fresh vector there is
    // nothing to ask the index with, and querying on the stale one would place the
    // entry by the text it no longer contains.
    if (reembedded?.values) {
      try {
        await inferEdgesOnWrite(id, await neighborsFromVectorQuery(reembedded.values, env), env);
      } catch (e) {
        console.error("Update auto-link failed (non-fatal):", e);
      }
    }

    return { status: "updated", vectorIds: newVectorIds };
  }

  // Out of attempts. The vectors just written describe text that never committed, so re-embed the
  // row as it now stands: the last upsert in any interleaving must describe committed text.
  if (last) await restoreRowVectors(env, id, last.vectorIds, reembedded?.vectorIds ?? [], last.row.source as string, config, last.embedCtx);
  return { status: "conflict" };
}

/** The row changed under a compare-and-set writer more often than it may retry: nothing was written. HTTP 409. */
export class WriteConflictError extends Error {
  constructor() { super("changed while saving, try again"); }
}

/** The row was forgotten between the caller's guard read and the write. */
export class EntryGoneError extends Error {
  constructor(id: string) { super(`No entry found with ID: ${id}`); }
}

/**
 * Append to an entry. The row is read here, not taken from the caller: a caller's `existingContent`
 * can be stale by the time it commits, and building the new text from it drops a concurrent append.
 * `existingContent`, `tags` and `source` are accepted for the callers that hold them and ignored.
 *
 * Short appends build the content in SQL (`content || suffix`) so no addition is lost, and
 * compare-and-set on the tags they read. Long appends re-embed the whole text, so they compare-and-set
 * on content and tags and retry from a fresh read. Either way a lost attempt writes no version.
 */
export async function appendToEntry(
  env: Env,
  id: string,
  _existingContent: string,
  addition: string,
  _tags: string[],
  _source: string,
  config: Readonly<Config> = DEFAULTS,
  volatility: Volatility | undefined,
  writeCtx: WriteContext,
  change: ChangeContext,
  /** An explicit time anchor set in the same batch as the text, so one undo restores both. */
  when?: { at: number; kind: string },
): Promise<boolean> {
  const nextWhen: WhenChange | undefined = when ? { when_at: when.at, when_kind: when.kind, when_source: "explicit" } : undefined;
  const whenSql = when ? `, when_at = ?, when_kind = ?, when_source = 'explicit'` : "";
  const whenBind = when ? [when.at, when.kind] : [];
  const meta = when ? { when: true } : undefined;

  // Spelled month, like every other date this app hands to a reader or a model: "8/2/2026" is two different days.
  const timestamp = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const suffix = `\n\n[Update ${timestamp}]: ${addition}`;

  // The short branch's chunk vector describes the addition alone, so it survives a tags retry.
  let chunk: { id: string; indexed: boolean; values: number[] } | null = null;
  const retireChunk = async () => {
    if (chunk?.indexed) {
      try { await deleteVectorIds(env, [chunk.id]); } catch (e) { console.error("Append chunk cleanup failed (non-fatal):", e); }
    }
  };

  for (let attempt = 1; attempt <= WRITE_CAS_ATTEMPTS; attempt++) {
    const row = await env.DB.prepare(
      // scope-exempt: by-id: routes gate with getReadableEntry + assertCanEditContent
      `SELECT content, tags, source, vector_ids, workspace_id FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;
    if (!row) { await retireChunk(); throw new EntryGoneError(id); }

    const readContent: string = row.content;
    const readTags: string = row.tags ?? "[]";
    const rowTags: string[] = JSON.parse(readTags);
    const source: string = row.source;
    const existingVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
    // The appended chunk's vector must live in the ROW's workspace, not the caller's default target.
    const embedCtx = embedContextForRow(row, writeCtx);
    // Unlike a replacement this keeps any existing volatility verdict (see tagsAfterAppend); a caller-supplied one overrides it.
    const appendedTags = tagsAfterAppend(rowTags);
    const refreshedTags = withUserEditMarker(volatility ? withVolatility(appendedTags, volatility) : appendedTags);
    const now = Date.now();

    if (readContent.length + suffix.length > CHUNK_MAX_CHARS) {
      // The whole text is re-embedded, so this commit must be of the text that was embedded.
      const newContent = readContent + suffix;
      const newVectorIds = (await reembedOrDegrade(env, id, newContent, rowTags, source, config, embedCtx))?.vectorIds ?? null;
      const committed = await env.DB.batch([
        snapshotStatement(env, {
          entryId: id, reason: "append", change, content: { kind: "next", content: newContent }, nextTags: refreshedTags, nextWhen, meta, now,
          guard: p => `e.content = ${p.add(readContent)} AND e.tags = ${p.add(readTags)}`,
        }),
        // versioning: snapshot
        env.DB.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ?${whenSql} WHERE id = ? AND content = ? AND tags = ?`)
          .bind(newContent, JSON.stringify(refreshedTags), now, ...whenBind, id, readContent, readTags),
        pruneStatement(env, id, config.VERSION_KEEP),
      ]);
      if (changesOf(committed[1]) === 0) {
        if (attempt < WRITE_CAS_ATTEMPTS) continue;
        // Out of attempts: the vectors just written describe text that never committed.
        await retireChunk();
        await restoreRowVectors(env, id, existingVectorIds, newVectorIds ?? [], source, config, embedCtx);
        throw new WriteConflictError();
      }
      // A short attempt earlier may have inserted a chunk this long commit re-embedded away.
      await retireChunk();

      // Skipped when Vectorize is unavailable: the old vectors are the entry's only remaining semantic index.
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

    if (!chunk) {
      const values = await embed(addition, env, config);
      const chunkId = `${id}-update-${Date.now()}`;
      const metadata: Record<string, any> = {
        content: addition, parentId: id, isUpdate: true, tags: rowTags, source, created_at: Date.now(), workspace_id: row.workspace_id ?? "",
      };
      rowTags.forEach(t => { metadata[`tag_${t.replace(/[."]/g, "_")}`] = true; });
      // Committed either way: keyword search reads entries.content, so an unindexed addition is
      // still recallable, whereas rejecting the append loses it outright. A transient failure still
      // throws: nothing is written yet, so the retry is safe.
      let indexed = true;
      try {
        await env.VECTORIZE.insert([{ id: chunkId, values, metadata }]);
      } catch (e) {
        if (!(await isVectorizeUnavailable(env))) throw e;
        console.error("Vectorize unavailable — appending without indexing the addition:", e);
        indexed = false;
      }
      chunk = { id: chunkId, indexed, values };
    }
    const { id: chunkId, indexed, values } = chunk;

    const committed = await env.DB.batch([
      snapshotStatement(env, {
        entryId: id, reason: "append", change, content: { kind: "suffix" }, nextTags: refreshedTags, nextWhen, meta, now,
        guard: p => `e.tags = ${p.add(readTags)}`,
      }),
      // versioning: snapshot
      env.DB.prepare(
        `UPDATE entries SET content = content || ?, vector_ids = CASE WHEN ? = 1 THEN json_insert(vector_ids, '$[#]', ?) ELSE vector_ids END, tags = ?, updated_at = ?${whenSql} WHERE id = ? AND tags = ?`
      ).bind(suffix, indexed ? 1 : 0, chunkId, JSON.stringify(refreshedTags), now, ...whenBind, id, readTags),
      pruneStatement(env, id, config.VERSION_KEEP),
    ]);
    if (changesOf(committed[1]) === 0) {
      if (attempt < WRITE_CAS_ATTEMPTS) continue;
      await retireChunk();
      throw new WriteConflictError();
    }

    try {
      await inferEdgesOnWrite(id, await neighborsFromVectorQuery(values, env), env);
    } catch (e) {
      console.error("Append auto-link failed (non-fatal):", e);
    }
    return indexed;
  }
  throw new WriteConflictError();
}
