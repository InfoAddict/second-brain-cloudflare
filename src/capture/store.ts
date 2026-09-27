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
import { buildCasGuard, changesOf, Params, pruneStatement, snapshotStatement, type WhenChange } from "../memory/versions";

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
  const stored = await upsertEntryVectors(env, id, content, tags, source, now, config, writeCtx);

  // This UPDATE is the tail of a version write (fresh vectors for the row). It
  // deliberately does NOT touch workspace_id: an update edits a row in place and
  // must never move it between workspaces — that is share/unshare's job alone.
  // Restamping here would let any context-less caller silently reset a row to ''.
  // versioning: exempt: vector bookkeeping
  await env.DB.prepare(
    `UPDATE entries SET vector_ids = ? WHERE id = ?`
  ).bind(JSON.stringify(stored.vectorIds), id).run();

  return stored;
}

/**
 * Chunk, embed and upsert an entry's vectors, without touching D1. `storeEntry` follows it with the
 * `vector_ids` UPDATE; a restore from the trash has no row yet, so it upserts first and puts the ids
 * in the INSERT that brings the row back.
 */
export async function upsertEntryVectors(
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

/**
 * Embeds and upserts to Vectorize only (upsertEntryVectors, not storeEntry): every caller of
 * reembedOrThrow/reembedOrDegrade commits vector_ids itself, inside its own compare-and-set batch
 * (update, append, merge, undo). storeEntry's own unconditional `vector_ids = ?` write, if it ran
 * here too, would race ahead of that guarded batch and could overwrite a concurrent short append's
 * json_insert with a vector_ids list that never saw it (ADV-4, residual). restoreRowVectors is the
 * one caller that has no batch of its own to fold this into, so it writes vector_ids explicitly.
 */
export async function reembedOrThrow(env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config> = DEFAULTS, writeCtx: WriteContext = OWNER_WRITE_CONTEXT): Promise<StoredEntry> {
  const stored = await upsertEntryVectors(env, id, content, tags, source, Date.now(), config, writeCtx);
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
      // scope-exempt: by-id: a faithful repair of the row's OWN vectors to match its OWN current
      // content is harmless regardless of which workspace it moved to since the merge's failed CAS
      // — unlike the destructive fallback below, this never touches content this call did not read.
      `SELECT content, tags, workspace_id, vector_ids FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;
    if (!current) {
      // Forgotten during the merge's re-embed: nothing owns the merge's vectors any more.
      await deleteVectorIds(env, [...new Set([...oldVectorIds, ...mergedVectorIds])]);
      return;
    }
    const restored = await reembedOrThrow(env, id, current.content as string, JSON.parse(current.tags ?? "[]"), source, cfg, embedContextForRow(current, writeCtx));
    // R3-3: the row's OWN current vector_ids (read moments ago, above), not the caller's
    // oldVectorIds/mergedVectorIds, is the stale-deletion candidate set. A short append that won
    // between this call's callers reading THEIR OWN vector_ids and this read adds a fresh
    // `id-update-<ts>` chunk this call never heard of; the caller's sets do not name it, so the old
    // unconditional overwrite below dropped it from vector_ids without ever handing it to
    // deleteVectorIds — an orphan in Vectorize under no row's list, forget and Delete forever
    // could never find it again. Reading it from the row itself catches every such chunk, won or
    // lost, since the fresh re-embed's restored.vectorIds already covers the row's current content
    // (this same append's text included) and supersedes it either way.
    const staleCandidates = [...new Set([...JSON.parse(current.vector_ids ?? "[]") as string[], ...oldVectorIds, ...mergedVectorIds])];
    // Conditional on the content this call actually re-embedded (R3-3): a write here with no guard
    // at all could still overwrite a vector_ids column describing content ANOTHER write already
    // moved past, in the gap between the read above and this statement.
    // versioning: exempt: vector bookkeeping (L5) — reembedOrThrow no longer writes this itself.
    const written = await env.DB.prepare(`UPDATE entries SET vector_ids = ? WHERE id = ? AND content = ?`)
      .bind(JSON.stringify(restored.vectorIds), id, current.content).run();
    // The stale set is only ever safe to delete once the row's own vector_ids column actually
    // points at restored.vectorIds instead: a missed guard means some OTHER write's vectors are
    // live under ids this call still thinks are stale, and deleting them would be exactly the
    // "delete a live deterministic vector" mistake this whole repair path exists to avoid.
    if (changesOf(written) > 0) await deleteStaleVectors(env, staleCandidates, restored.vectorIds);
  } catch (e) {
    console.error("Restoring vectors after a lost write failed (non-fatal):", e);
    // The row's vector_ids now names vectors holding the loser's text. Emptying them makes
    // /vectorize-pending re-index the row from its own content, and the vectors go best-effort.
    try {
      // versioning: exempt: vector bookkeeping (L5)
      await env.DB.prepare(
        // Pinned to the write's workspace: a destructive clear must not touch a row that moved (recheck ownership).
        `UPDATE entries SET vector_ids = '[]' WHERE id = ? AND workspace_id = ?`
      ).bind(id, writeCtx.workspaceId).run();
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
  /** R2-5: the row still exists, but it moved out of the caller's authorized workspace since the
   * caller's own scoped read (an unshare mid-edit) — a conflict to retry, not a memory that vanished. */
  | { status: "moved" }
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
  /** The workspace the CALLER's own scoped read authorized (getReadableEntry + assertCanEditContent),
   * required so an unshare in the awaited gap between that read and this call's own first read (R2-3)
   * cannot land as "authorized" here — this call's guard pins to it, not to whatever it reads later. */
  authorizedWorkspaceId: string,
): Promise<UpdateEntryResult> {
  // A route's own scoped read can carry workspace_id as null/undefined for a row from before the
  // workspace column existed; this call's OWN read of the same row (below) always normalizes it to
  // "" (COALESCE-equivalent), so the pin must match that or a legitimate legacy row's every write
  // reports "moved" forever. Normalize once here rather than trust every call site to.
  const pinnedWorkspaceId = authorizedWorkspaceId ?? "";
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
  // R2-2: a lost or failed attempt's own embed shares a DETERMINISTIC vector id with the row's real
  // live vectors (the id, or id-chunk-i) — deleting it outright can delete a WINNING concurrent
  // write's vector, not just this attempt's own. Re-embed the row as it now stands instead, which
  // self-heals regardless of who actually won; never delete an attempt's vectors directly.
  const recoverFromLostAttempt = async () => {
    if (!reembedded?.vectorIds.length) return;
    if (last) await restoreRowVectors(env, id, last.vectorIds, reembedded.vectorIds, last.row.source as string, config, last.embedCtx);
    else { try { await deleteVectorIds(env, reembedded.vectorIds); } catch (e) { console.error("Orphan vector cleanup failed (non-fatal):", e); } }
  };

  for (let attempt = 1; attempt <= WRITE_CAS_ATTEMPTS; attempt++) {
    // vector_ids has to be read before any mutation: storeEntry overwrites it, and the
    // cleanup below needs to know which vectors the entry had on the way in.
    const row = await env.DB.prepare(
      // scope-exempt: by-id: routes gate with getReadableEntry + assertCanEditContent
      `SELECT content, tags, source, vector_ids, workspace_id FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;

    if (!row) {
      // Forgotten meanwhile: its own vectors went with it, and any this write made are orphans.
      await recoverFromLostAttempt();
      return { status: "not_found" };
    }

    if (row.workspace_id !== pinnedWorkspaceId) {
      // The row moved since the caller's own authorization (R2-3: that may be the route's read, not
      // this call's): write nothing. Retrying would re-authorize against wherever it landed, which is
      // exactly the cross-tenant write this guard refuses. Distinct from not_found (R2-5): the row is
      // still there, just not here for this caller any more — a conflict, not a 404.
      await recoverFromLostAttempt();
      return { status: "moved" };
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
      // A previous attempt's embed is being abandoned for this fresh one (content moved again since
      // it ran): recover it now (R2-2), or its deterministic ids sit in vector_ids for the next
      // commit — whichever branch it takes — to build on top of, the exact orphan the short-append
      // json_insert case hit.
      await recoverFromLostAttempt();
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
    // this call's to decide. It IS part of the guard (ADV-2): a row this call is no longer
    // authorized to write into must miss, not commit into wherever it ended up.
    // The prior state is kept in the same batch as the change, and a lost attempt writes neither.
    // vector_ids is set HERE, atomically with content and under the same guard (ADV-4) — not left
    // to storeEntry's own unconditional write, which a losing attempt would otherwise leave behind
    // for the next attempt's statement to build on top of.
    const now = Date.now();
    const casColumns = { content: readContent, tags: readTags, workspace_id: pinnedWorkspaceId };
    const p = new Params();
    const contentIdx = p.add(finalContent);
    const tagsIdx = p.add(JSON.stringify(committedTags));
    const nowIdx = p.add(now);
    const vectorIdsIdx = p.add(newVectorIds ? JSON.stringify(newVectorIds) : row.vector_ids);
    const idIdx = p.add(id);
    let committed: Awaited<ReturnType<typeof env.DB.batch>>;
    try {
      committed = await env.DB.batch([
        snapshotStatement(env, {
          entryId: id, reason: "update", change, content: { kind: "next", content: finalContent }, nextTags: committedTags, now,
          // ADV-10: readContent is this write's own base, right here in JS — its UTF-16 length is the
          // exact boundary a later reconstruction needs, at zero cost. Stored only when this row
          // actually lands as a delta (buildSnapshot nulls it out on a full copy, same as prior_length).
          priorLengthUtf16: readContent.length,
          guard: p2 => buildCasGuard(p2, casColumns),
        }),
        // versioning: snapshot
        env.DB.prepare(`UPDATE entries AS e SET content = ${contentIdx}, tags = ${tagsIdx}, updated_at = ${nowIdx}, vector_ids = ${vectorIdsIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`)
          .bind(...p.values()),
        pruneStatement(env, id, config.VERSION_KEEP),
      ]);
    } catch (e) {
      // The batch never landed, but the embed above already committed vector_ids-shaped ids
      // describing text that was never saved (U6): re-embed the row as it now stands before
      // the caller sees the error, so a thrown batch cannot leave the index ahead of D1.
      await recoverFromLostAttempt();
      throw e;
    }
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
  when: { at: number; kind: string } | undefined,
  /** The workspace the CALLER's own scoped read authorized, same reasoning as updateEntryContent's
   * identical parameter (R2-3): this call's guard pins to it, not to whatever it reads later. */
  authorizedWorkspaceId: string,
): Promise<boolean> {
  // See updateEntryContent's identical normalization: this call's own read of the row (below)
  // always coalesces workspace_id to "", so the pin must match that or a legacy row with no
  // workspace_id column value yet ever appends again.
  const pinnedWorkspaceId = authorizedWorkspaceId ?? "";
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

  // R2-2: same reasoning as updateEntryContent's recoverFromLostAttempt — a lost attempt's own embed
  // shares a deterministic vector id with the row's real live vectors, so deleting it outright can
  // delete a winning concurrent write's vector. Re-embed the row as it now stands instead.
  const recoverFromLostAttempt = async (existingVectorIds: string[], source: string, embedCtx: WriteContext, newVectorIds: string[] | null) => {
    if (!newVectorIds?.length) return;
    await restoreRowVectors(env, id, existingVectorIds, newVectorIds, source, config, embedCtx);
  };

  for (let attempt = 1; attempt <= WRITE_CAS_ATTEMPTS; attempt++) {
    const row = await env.DB.prepare(
      // scope-exempt: by-id: routes gate with getReadableEntry + assertCanEditContent
      `SELECT content, tags, source, vector_ids, workspace_id FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;
    if (!row) { await retireChunk(); throw new EntryGoneError(id); }
    if (row.workspace_id !== pinnedWorkspaceId) {
      // The row moved since the caller's own authorization (R2-3: that may be the route's read, not
      // this call's) — nothing here to append to: retrying would append into a workspace this
      // request was never cleared to write into.
      await retireChunk();
      throw new EntryGoneError(id);
    }

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

    if (readContent.length + suffix.length > CHUNK_MAX_CHARS) {
      // The whole text is re-embedded, so this commit must be of the text that was embedded.
      const newContent = readContent + suffix;
      const newVectorIds = (await reembedOrDegrade(env, id, newContent, rowTags, source, config, embedCtx))?.vectorIds ?? null;
      // ADV-12: taken AFTER the embed, not before — a slow embed that lets a concurrent append commit
      // first must not stamp this later write with an earlier time than the one it lands on top of.
      const now = Date.now();
      const longCasColumns = { content: readContent, tags: readTags, workspace_id: pinnedWorkspaceId };
      const p = new Params();
      const contentIdx = p.add(newContent);
      const tagsIdx = p.add(JSON.stringify(refreshedTags));
      const nowIdx = p.add(now);
      const vectorIdsIdx = p.add(newVectorIds ? JSON.stringify(newVectorIds) : row.vector_ids);
      const whenIdx = when ? [p.add(when.at), p.add(when.kind)] : [];
      const idIdx = p.add(id);
      let committed: Awaited<ReturnType<typeof env.DB.batch>>;
      try {
        committed = await env.DB.batch([
          snapshotStatement(env, {
            entryId: id, reason: "append", change, content: { kind: "next", content: newContent }, nextTags: refreshedTags, nextWhen, meta, now,
            // ADV-10: see updateEntryContent's identical reasoning above.
            priorLengthUtf16: readContent.length,
            guard: p2 => buildCasGuard(p2, longCasColumns),
          }),
          // R2-6: updated_at clamped to at least the version this same batch's snapshot just landed
          // (already clamped itself), the same reasoning as buildSnapshot's own created_at floor —
          // this UPDATE runs after that INSERT in the same batch, so it sees the fresh row.
          // versioning: snapshot — vector_ids set here, atomically with content, under the same guard (ADV-4).
          // scope-exempt: by-id: the clamp's entry_versions subquery is correlated to this same
          // row's id, the same id the outer UPDATE's own WHERE clause already pins.
          env.DB.prepare(`UPDATE entries AS e SET content = ${contentIdx}, tags = ${tagsIdx}, updated_at = MAX(${nowIdx}, COALESCE((SELECT MAX(v.created_at) FROM entry_versions v WHERE v.entry_id = ${idIdx}), 0)), vector_ids = ${vectorIdsIdx}${when ? `, when_at = ${whenIdx[0]}, when_kind = ${whenIdx[1]}, when_source = 'explicit'` : ""} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, longCasColumns)}`)
            .bind(...p.values()),
          pruneStatement(env, id, config.VERSION_KEEP),
        ]);
      } catch (e) {
        // U6: the batch never landed, but the embed above already committed vector_ids-shaped ids
        // describing text that was never saved.
        await recoverFromLostAttempt(existingVectorIds, source, embedCtx, newVectorIds);
        throw e;
      }
      if (changesOf(committed[1]) === 0) {
        // This attempt's own embed never committed (R2-2): recover it now, not just on final
        // exhaustion — otherwise it sits in vector_ids for whichever branch the next attempt takes
        // to build on top of (the short branch's json_insert reads vector_ids fresh at commit time).
        await recoverFromLostAttempt(existingVectorIds, source, embedCtx, newVectorIds);
        if (attempt < WRITE_CAS_ATTEMPTS) continue;
        // Out of attempts: re-embed the row as it now stands, so the last upsert describes committed text.
        await retireChunk();
        await restoreRowVectors(env, id, existingVectorIds, [], source, config, embedCtx);
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

    // ADV-12: taken AFTER the chunk embed, not before — see the long branch's identical reasoning above.
    const now = Date.now();
    const shortCasColumns = { tags: readTags, workspace_id: pinnedWorkspaceId };
    const shortP = new Params();
    const suffixIdx = shortP.add(suffix);
    const indexedIdx = shortP.add(indexed ? 1 : 0);
    const chunkIdx = shortP.add(chunkId);
    const shortTagsIdx = shortP.add(JSON.stringify(refreshedTags));
    const shortNowIdx = shortP.add(now);
    const shortWhenIdx = when ? [shortP.add(when.at), shortP.add(when.kind)] : [];
    const shortIdIdx = shortP.add(id);
    let committed: Awaited<ReturnType<typeof env.DB.batch>>;
    try {
      committed = await env.DB.batch([
        snapshotStatement(env, {
          entryId: id, reason: "append", change, content: { kind: "suffix" }, nextTags: refreshedTags, nextWhen, meta, now,
          // R2-1: NOT stamped here, unlike the long branch and updateEntryContent above — this
          // branch's guard (shortCasColumns) does not include content, so a concurrent short append
          // can land between this read and this commit, making readContent.length describe a state
          // shorter than what this version actually retires. buildChain falls back to its scan.
          guard: p => buildCasGuard(p, shortCasColumns),
        }),
        // versioning: snapshot — R2-6: updated_at clamped, same reasoning as the long branch above.
        // scope-exempt: by-id: same correlated-subquery reasoning as the long branch above.
        env.DB.prepare(
          `UPDATE entries AS e SET content = content || ${suffixIdx}, vector_ids = CASE WHEN ${indexedIdx} = 1 THEN json_insert(vector_ids, '$[#]', ${chunkIdx}) ELSE vector_ids END, tags = ${shortTagsIdx}, updated_at = MAX(${shortNowIdx}, COALESCE((SELECT MAX(v.created_at) FROM entry_versions v WHERE v.entry_id = ${shortIdIdx}), 0))${when ? `, when_at = ${shortWhenIdx[0]}, when_kind = ${shortWhenIdx[1]}, when_source = 'explicit'` : ""} WHERE e.id = ${shortIdIdx} AND ${buildCasGuard(shortP, shortCasColumns)}`
        ).bind(...shortP.values()),
        pruneStatement(env, id, config.VERSION_KEEP),
      ]);
    } catch (e) {
      await retireChunk();
      throw e;
    }
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
