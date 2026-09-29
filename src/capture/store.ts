import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { CHUNK_MAX_CHARS, MIRRORED_SOURCES, VECTORIZE_UPSERT_BATCH, WRITE_CAS_ATTEMPTS } from "../constants";
import { embed, embedMany } from "../lib/ai";
import { inferEdgesOnWrite } from "../graph/edges";
import { neighborsFromVectorQuery } from "../graph/traverse";
import { chunkText } from "../text/chunk";
import { deleteEntryVectors } from "../vectorize/batch";
import { newVectorIds as mintVectorIds } from "../vectorize/ids";
import { rememberTags } from "../tags/vocabulary";
import { applyTagReplacement, withUserEditMarker } from "../tags/system";
import { extractHashtags } from "../text/hashtags";
import { isVectorizeUnavailable } from "../vectorize/health";
import { tagsAfterWrite, tagsAfterAppend } from "../memory/stale";
import { withVolatility, type Volatility } from "../memory/volatility";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import type { ChangeContext, AuditChannel } from "../lib/audit";
import { buildCasGuard, changesOf, Params, pruneStatement, snapshotStatement, type WhenChange } from "../memory/versions";
import { INDEXABLE_SQL } from "./lifecycle";
import { scoreWrite, type QuarantineChannel } from "../quarantine/score";
import { heldTagsFor, holdDecision, holdStatements, type HeldInfo } from "../quarantine/hold";
import { isHeld, withEditedCanonical } from "../quarantine/tags";
import { countMcpWritesInWindow } from "../quarantine/burst";
import { getStatus } from "../memory/status";
import { isCapsuleTag } from "../tags/system";
import { STANDING_TAG } from "../tags/t7";
import { buildStandingCache, standingTouched, type StandingCacheConfig } from "../standing/cache";

/** 5.7/5.2 C1: the capsule: / capsule-slot: tag set changed between two tag lists. */
function capsuleTagsDiffer(before: readonly string[], after: readonly string[]): boolean {
  const norm = (tags: readonly string[]) => JSON.stringify([...tags].filter(isCapsuleTag).sort());
  return norm(before) !== norm(after);
}

/**
 * Review NIT fix (spec 15 2.6): updateEntryContent and appendToEntry both re-embed the row, so a
 * standing instruction's cached vector goes stale the moment either commits — whether or not the
 * tags themselves changed. Touched whenever either side of the edit carries standing:active,
 * covering an edit that adds it, removes it, or leaves it in place with new content. `ctx` is
 * optional, like updateEntryValidity's own fix: a caller with none still gets a correct rebuild,
 * awaited inline instead of deferred off the response path.
 */
async function touchStandingIfNeeded(
  env: Env, ctx: ExecutionContext | undefined, config: Readonly<Config>, workspaceId: string,
  priorTags: readonly string[], nextTags: readonly string[],
  known?: readonly { id: string; vector: number[] }[],
): Promise<void> {
  if (!priorTags.includes(STANDING_TAG) && !nextTags.includes(STANDING_TAG)) return;
  if (ctx) standingTouched(env, ctx, config as StandingCacheConfig, [workspaceId], known);
  else await buildStandingCache(env, config as StandingCacheConfig, workspaceId, known ?? []);
}

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
  /** storeEntry only: false when the vector_ids write lost its compare-and-set (content or
   * workspace changed during the embed), so these vectors are not the row's. */
  committed?: boolean;
}

export async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number,
  config: Readonly<Config> = DEFAULTS,
  writeCtx: WriteContext = OWNER_WRITE_CONTEXT,
  /** The vector_ids the caller read for this row (JSON, e.g. '[]' for a new or pending row). */
  commit: { expectedVectorIds: string } = { expectedVectorIds: "[]" },
): Promise<StoredEntry> {
  // Codex review, T-0102 F3 (MAJOR): the "batch-embed: exempt" reasoning this comment used to
  // give -- a held write never reaches this function via class A's gate, so content here is
  // always under the scorer's 32 KB budget -- is only true for captureEntry's own create-time
  // call. Two other callers route through storeEntry with content that was never scored at all
  // and can be up to the full 128 KB cap: vectorize/pending.ts's indexPendingRow (a deferred row, chosen by length
  // alone) and migration/embedding.ts's backfill pass. Both would cost one AI call per chunk
  // without this. Always batchEmbeds now, not opt-in: embedMany costs the same as embed for the
  // common one-or-two-chunk capture (R20 never regresses that caller), and only ever helps a
  // larger one.
  const stored = await upsertEntryVectors(env, id, content, tags, source, now, config, writeCtx, { batchEmbeds: true });

  // This UPDATE is the tail of a version write (fresh vectors for the row). It
  // deliberately does NOT touch workspace_id: an update edits a row in place and
  // must never move it between workspaces — that is share/unshare's job alone.
  // Restamping here would let any context-less caller silently reset a row to ''.
  // Compare-and-set on the content AND the workspace these vectors were stamped for (R4-2, round 5),
  // AND the vector_ids the caller read (round 6): the row alone decides which upload won, and an
  // upload that lost is this call's own ids, deleted here and nowhere else.
  // Codex review, T-0102 D4: also gated on INDEXABLE_SQL, checked at commit time rather than
  // pinned to a snapshot value. upsertEntryVectors above checked isHeld on the tags THIS call was
  // given, but embedding takes time (an AI call), and nothing between that check and this UPDATE
  // stopped a concurrent write from holding or deprecating the row in the meantime — landing a
  // real, indexed vector on a row the hold or deprecation contract says must have none.
  // versioning: exempt: vector bookkeeping
  const result = await env.DB.prepare(
    `UPDATE entries SET vector_ids = ? WHERE id = ? AND content = ? AND workspace_id = ? AND vector_ids = ? AND ${INDEXABLE_SQL}`
  ).bind(JSON.stringify(stored.vectorIds), id, content, writeCtx.workspaceId, commit.expectedVectorIds).run();

  if (changesOf(result) === 0) {
    await discardUpload(env, id, stored.vectorIds);
    return { ...stored, committed: false };
  }

  return { ...stored, committed: true };
}

/**
 * An upload that did not become the row's vector_ids (a lost compare-and-set, a thrown batch, a
 * superseded attempt). Its ids were minted for this upload alone (newVectorIds), so deleting them can
 * never touch another writer's vectors, and the row's own listed vectors were never overwritten.
 */
export async function discardUpload(env: Env, entryId: string, uploadedIds: string[] | null | undefined): Promise<void> {
  if (!uploadedIds?.length) return;
  try { await deleteEntryVectors(env, [{ entryId, vectorIds: uploadedIds }]); } catch (e) { console.error("Deleting a discarded vector upload failed (non-fatal):", e); }
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
  writeCtx: WriteContext = OWNER_WRITE_CONTEXT,
  /** Embed chunks embedBatchSize() per AI call (the nightly backfill), rather than one call each. */
  opts: { batchEmbeds?: boolean } = {},
): Promise<StoredEntry> {
  // Codex review class A (T-0089.4.2): the one gate every embed-or-upsert site for a row's real
  // content routes through — this is the single low-level function every one of them (storeEntry,
  // reembedOrThrow, reembedOrDegrade, undo's reembedForRevert, trash restore, mirror sync, the
  // embedding migration, vectorize-pending) already calls to talk to Vectorize. A row whose OWN
  // tags are still held must never be embedded, whichever route reached this call — that is
  // exactly the invariant a hold exists to enforce, and it must hold even when the caller (a
  // restore, a nightly repair) never scored this write itself. `tags` here is always the tags
  // this call is ABOUT to commit, never assumed: a deliberate release passes the row's post-
  // release (unheld) tags, so it passes this gate without needing a bypass flag.
  if (isHeld(tags)) throw new HeldRowEmbedRefusedError(id);
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

  const batched = opts.batchEmbeds ? await embedMany(chunks, env, config) : null;
  // Fresh ids for this upload alone (round 6): never the deterministic ids 3.7 used.
  const ids = mintVectorIds(id, chunks.length);
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
        id: ids[i],
        values: batched ? batched[i] : await embed(chunk, env, config),
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

export async function deleteStaleVectors(env: Env, entryId: string, oldIds: string[], newIds: string[]): Promise<void> {
  if (!newIds.length) return;
  const keep = new Set(newIds);
  const stale = oldIds.filter(v => !keep.has(v));
  if (stale.length) await deleteEntryVectors(env, [{ entryId, vectorIds: stale }]);
}

/**
 * Embeds and upserts to Vectorize only (upsertEntryVectors, not storeEntry): every caller of
 * reembedOrThrow/reembedOrDegrade commits vector_ids itself, inside its own compare-and-set batch
 * (update, append, merge, undo). storeEntry's own unconditional `vector_ids = ?` write, if it ran
 * here too, would race ahead of that guarded batch and could overwrite a concurrent short append's
 * json_insert with a vector_ids list that never saw it (ADV-4, residual). storeEntry is the one
 * writer without such a batch; it compare-and-sets vector_ids on its own.
 *
 * Budget auditor R20 (T-0089.4.2, T-0089.5.9): always batchEmbeds — every caller here is
 * re-embedding EXISTING or merged content, which can be arbitrarily large (a 128 KB Release, a
 * merge target), unlike storeEntry's own create-time embed, which only ever sees content a hold
 * would have already caught above the scorer's 32 KB budget. embedMany costs the same one AI call
 * as the single-text embed helper does for the common few-chunk case (it batches up to
 * embedBatchSize() texts per call), so there is no downside to always taking this path here.
 */
export async function reembedOrThrow(env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config> = DEFAULTS, writeCtx: WriteContext = OWNER_WRITE_CONTEXT): Promise<StoredEntry> {
  const stored = await upsertEntryVectors(env, id, content, tags, source, Date.now(), config, writeCtx, { batchEmbeds: true });
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
  | {
    status: "updated"; vectorIds: string[] | null;
    /** Track 4 (5.4 W-b): set when this edit scored high enough to be held. */
    held?: HeldInfo;
    /** 5.7: this row's status was canonical before this edit landed (mcp only; REST gets no label). */
    wasCanonical?: boolean;
    /** 5.7: this edit added or redefined a capsule:/capsule-slot: tag. */
    capsuleChanged?: boolean;
    /** Round 4 re-review MAJOR (undo-group "dead for canonical edits and capsule changes"): this
     * write's own version carries this same id at meta.event_id, minted here and not by
     * auditEventStatement's own default, so the caller's "updated" event can pass it straight
     * through -- the exact link classifyFromRows requires to ever group and revert this edit. */
    eventId: string;
  };

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
  ctx?: ExecutionContext,
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

  // The row this write embedded from. The commit compares-and-sets on it (and on the vector_ids read),
  // so a second writer that committed in between is never overwritten in D1.
  let embeddedFrom: string | null = null;
  let reembedded: StoredEntry | null = null;
  let last: { row: Record<string, any>; vectorIds: string[]; embedCtx: WriteContext } | null = null;
  // A lost, failed or superseded attempt's own upload: its ids are this attempt's alone (round 6),
  // so it is deleted outright; the row's own listed vectors were never overwritten by it.
  const recoverFromLostAttempt = async () => {
    await discardUpload(env, id, reembedded?.vectorIds);
    reembedded = null;
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
    let committedTags = withUserEditMarker(mergedTags);

    // 5.7: the canonical-edit label. MCP only — a REST edit (the person) gets no label. Added to
    // the tags this edit is writing whether or not it ends up held below: a held row's status
    // moves to draft either way, so the label is moot there, but it costs nothing to include.
    const wasCanonical = getStatus(existingTags) === "canonical";
    if (change.channel === "mcp" && wasCanonical) committedTags = withEditedCanonical(committedTags, Date.now());
    const capsuleChanged = capsuleTagsDiffer(existingTags, committedTags);

    // Track 4 (5.1, 5.4 W-b): scored on the resulting content. D4.1: an already-held row is
    // never rescored — quarantine:* is worker-owned, so applyTagReplacement above already kept
    // it regardless of what the caller asked to replace it with.
    const alreadyHeld = isHeld(existingTags);
    let score: ReturnType<typeof scoreWrite> | null = null;
    if (!alreadyHeld && (change.channel === "mcp" || change.channel === "rest")) {
      const channel: QuarantineChannel = change.channel;
      const mcpWritesInWindow = channel === "mcp"
        ? await countMcpWritesInWindow(env, change.actorId, Date.now(), config.QUARANTINE_WRITE_BURST)
        : undefined;
      score = scoreWrite(
        { content: finalContent, tags: committedTags, source, channel, kind: "update", mcpWritesInWindow, capsuleTagsChanged: capsuleChanged },
        config,
      );
    }
    // Codex review class D (T-0089.4.2): a `partial` score holds too, reason too_long.
    const decision = score ? holdDecision(score) : { hold: false as const };
    const heldTags = decision.hold ? heldTagsFor(committedTags, decision.reasons) : null;

    // Re-embed FIRST (#212): if it fails, leave the entry's content and vectors untouched and
    // surface an error, instead of committing new content and then deleting every vector —
    // which would leave the entry silently unsearchable. null means Vectorize is unreachable
    // (#270), not that this embed failed. A retry re-embeds only if the row's text changed (another
    // writer may have upserted over these ids); a tags-only change keeps the vectors already made.
    // 5.4 W-b: a held write skips this pre-commit re-embed entirely (saves a model call) — the
    // row is never vectorized, so there is nothing to embed for. Codex review class A
    // (T-0089.4.2): an edit that keeps an ALREADY-held row held (D4.1, not rescored) must skip it
    // too — committedTags still carries the quarantine: tag, and upsertEntryVectors' own gate
    // now refuses that content outright rather than silently indexing a row a hold excludes.
    if (!heldTags && !alreadyHeld && (attempt === 1 || embeddedFrom !== readContent)) {
      // A previous attempt's embed is being abandoned for this fresh one (content moved again since
      // it ran): delete its upload now, before embedding again.
      await recoverFromLostAttempt();
      try {
        reembedded = await reembedOrDegrade(env, id, finalContent, mergedTags, source, config, embedCtx);
      } catch (e) {
        console.error("Re-embed failed — entry left unchanged:", e);
        return { status: "reembed_failed" };
      }
      embeddedFrom = readContent;
    }
    if (heldTags) await recoverFromLostAttempt();
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
    // Round 4 re-review MAJOR: minted here, not by auditEventStatement's own default, so this
    // version's meta.event_id and the "updated" event it lands with moments later (the caller,
    // after this returns) share the SAME id.
    const eventId = crypto.randomUUID();
    // vector_ids too (round 6): the row decides which upload won, and old ids retired below are
    // exactly the ones this commit replaced.
    const casColumns = { content: readContent, tags: readTags, workspace_id: pinnedWorkspaceId, vector_ids: row.vector_ids ?? null };
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
          entryId: id, reason: "update", change, content: { kind: "next", content: finalContent }, nextTags: committedTags,
          meta: { event_id: eventId }, now,
          // ADV-10: readContent is this write's own base, right here in JS — its UTF-16 length is the
          // exact boundary a later reconstruction needs, at zero cost. Stored only when this row
          // actually lands as a delta (buildSnapshot nulls it out on a full copy, same as prior_length).
          priorLengthUtf16: readContent.length,
          guard: p2 => buildCasGuard(p2, casColumns),
        }),
        // updated_at clamped strictly past its own previous value (the digest mark guard,
        // src/compression/digest.ts, trusts COALESCE(updated_at, created_at) plus byte length as
        // its change signal; a same-millisecond, same-length edit with no clamp would leave it unmoved).
        // versioning: snapshot
        env.DB.prepare(`UPDATE entries AS e SET content = ${contentIdx}, tags = ${tagsIdx}, updated_at = MAX(${nowIdx}, COALESCE(e.updated_at, e.created_at) + 1), vector_ids = ${vectorIdsIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`)
          .bind(...p.values()),
        pruneStatement(env, id, config.VERSION_KEEP),
        // 5.4 W-b: holdStatements appended to the same batch — the edit above is its own version
        // and the hold is the next. Guarded on the edit's own post-state, so a lost compare-and-set
        // (the UPDATE above changed nothing) cannot land the hold either.
        ...(heldTags && decision.hold ? holdStatements(env, { snapshotStatement, pruneStatement, versionKeep: config.VERSION_KEEP }, {
          entryId: id, reasons: decision.reasons, score: decision.score, signals: decision.signals, change, heldTags, now,
          // holdStatements' own UPDATE targets plain `entries`, unaliased (unlike the snapshot's `entries e` above).
          guard: p2 => `content = ${p2.add(finalContent)} AND tags = ${p2.add(JSON.stringify(committedTags))}`,
        }) : []),
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

    if (heldTags) {
      // No new upload to compare stale ids against (deleteStaleVectors no-ops when newIds is
      // empty, by design — held is the one caller that means it): delete the row's PRIOR
      // vectors directly, after commit, same as deprecateEntry (5.3 point 1).
      if (oldVectorIds.length) {
        try {
          await deleteEntryVectors(env, [{ entryId: id, vectorIds: oldVectorIds }]);
        } catch (e) {
          console.error("Vectorize delete failed after a held update (non-fatal):", e);
        }
      }
      await touchStandingIfNeeded(env, ctx, config, embedCtx.workspaceId, existingTags, committedTags);
      return { status: "updated", vectorIds: null, held: decision.hold ? { reasons: decision.reasons, score: decision.score } : undefined, wasCanonical, capsuleChanged, eventId };
    }

    if (newVectorIds) {
      try {
        await deleteStaleVectors(env, id, oldVectorIds, newVectorIds);
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

    await touchStandingIfNeeded(env, ctx, config, embedCtx.workspaceId, existingTags, committedTags, reembedded?.values ? [{ id, vector: reembedded.values }] : undefined);
    return { status: "updated", vectorIds: newVectorIds, wasCanonical, capsuleChanged, eventId };
  }

  // Out of attempts: the last upload never became the row's, so it goes.
  await recoverFromLostAttempt();
  return { status: "conflict" };
}

/** The row changed under a compare-and-set writer more often than it may retry: nothing was written. HTTP 409. */
export class WriteConflictError extends Error {
  constructor() { super("changed while saving, try again"); }
}

/** The row was forgotten between the caller's guard read and the write. */
export class EntryGoneError extends Error {
  constructor(id: string) { super(`No memory found with ID: ${id}`); }
}

/** Codex review class A (T-0089.4.2): upsertEntryVectors' own refusal when the tags it was asked
 * to embed are still held. Every caller either already checks `isHeld` before it gets here (the
 * ordinary write paths, which never call this with held tags to begin with) or must now handle
 * this explicitly (trash restore, undo's release paths) — a thrown error, not a silent no-op, so
 * a caller that forgets fails loudly in tests rather than shipping a quiet embed. */
export class HeldRowEmbedRefusedError extends Error {
  constructor(id: string) { super(`refusing to embed held row ${id}`); }
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
/** 5.4 W-c: the appended text is scored with this much of the prior content for context, not
 * the whole entry — bounded, regardless of how long the entry already is. */
export const APPEND_SCORE_CONTEXT_CHARS = 2000;

export interface AppendResult {
  indexed: boolean;
  /** Track 4 (5.4 W-c): set when this append scored high enough to be held. */
  held?: HeldInfo;
  /** 5.7: this row's status was canonical before this append landed (mcp only). */
  wasCanonical?: boolean;
  /** Round 4 re-review MAJOR (undo-group "dead for canonical edits and capsule changes"): this
   * write's own version carries this same id at meta.event_id -- see UpdateEntryResult's own note. */
  eventId: string;
}

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
  ctx?: ExecutionContext,
): Promise<AppendResult> {
  // See updateEntryContent's identical normalization: this call's own read of the row (below)
  // always coalesces workspace_id to "", so the pin must match that or a legacy row with no
  // workspace_id column value yet ever appends again.
  const pinnedWorkspaceId = authorizedWorkspaceId ?? "";
  const nextWhen: WhenChange | undefined = when ? { when_at: when.at, when_kind: when.kind, when_source: "explicit" } : undefined;
  const whenSql = when ? `, when_at = ?, when_kind = ?, when_source = 'explicit'` : "";
  const whenBind = when ? [when.at, when.kind] : [];
  // Round 4 re-review MAJOR (undo-group "dead for canonical edits and capsule changes"): each
  // attempt mints its own event id, merged in below at the one point each branch actually commits
  // -- not by auditEventStatement's own default -- so this version's meta.event_id and the
  // "appended" event the caller lands moments later share the SAME id.
  const metaFor = (eventId: string) => (when ? { when: true, event_id: eventId } : { event_id: eventId });

  // Spelled month, like every other date this app hands to a reader or a model: "8/2/2026" is two different days.
  const timestamp = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const suffix = `\n\n[Update ${timestamp}]: ${addition}`;

  // The short branch's chunk vector describes the addition alone, so it survives a tags retry.
  let chunk: { id: string; indexed: boolean; values: number[] } | null = null;
  const retireChunk = async () => {
    if (chunk?.indexed) {
      try { await deleteEntryVectors(env, [{ entryId: id, vectorIds: [chunk.id] }]); } catch (e) { console.error("Append chunk cleanup failed (non-fatal):", e); }
    }
  };

  // A lost attempt's own upload: its ids are this attempt's alone (round 6), so it is deleted outright.
  const recoverFromLostAttempt = async (_existingVectorIds: string[], _source: string, _embedCtx: WriteContext, uploaded: string[] | null) => {
    await discardUpload(env, id, uploaded);
  };

  for (let attempt = 1; attempt <= WRITE_CAS_ATTEMPTS; attempt++) {
    const eventId = crypto.randomUUID();
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
    let refreshedTags = withUserEditMarker(volatility ? withVolatility(appendedTags, volatility) : appendedTags);

    // 5.7: the canonical-edit label applies to append too, MCP only.
    const wasCanonical = getStatus(rowTags) === "canonical";
    if (change.channel === "mcp" && wasCanonical) refreshedTags = withEditedCanonical(refreshedTags, Date.now());

    // Track 4 (5.1, 5.4 W-c): scored on the addition plus bounded prior context, never the
    // whole entry. D4.1: an already-held row is never rescored.
    const alreadyHeld = isHeld(rowTags);
    let score: ReturnType<typeof scoreWrite> | null = null;
    if (!alreadyHeld && (change.channel === "mcp" || change.channel === "rest")) {
      const channel: QuarantineChannel = change.channel;
      const mcpWritesInWindow = channel === "mcp"
        ? await countMcpWritesInWindow(env, change.actorId, Date.now(), config.QUARANTINE_WRITE_BURST)
        : undefined;
      score = scoreWrite(
        {
          content: readContent.slice(-APPEND_SCORE_CONTEXT_CHARS) + addition,
          tags: refreshedTags, source, channel, kind: "append", mcpWritesInWindow,
        },
        config,
      );
    }
    // Codex review class D (T-0089.4.2): a `partial` score holds too, reason too_long — the
    // scored slice here is already bounded (2,000 characters of context plus the addition), so
    // this only fires when the addition itself is large enough to trip the scorer's own 32 KB cap.
    const decision = score ? holdDecision(score) : { hold: false as const };
    const heldTags = decision.hold ? heldTagsFor(refreshedTags, decision.reasons) : null;

    // Codex recheck (T-0089.4.2): an earlier attempt's short-branch chunk embed below can commit
    // it to Vectorize, then lose its own CAS guard to a concurrent write that holds the row —
    // this retry then finds heldTags or alreadyHeld true, but `chunk` still names that now-stale
    // upload. Left alone, the short branch's UPDATE (further below) would json_insert it into
    // vector_ids regardless, indexing a row a hold excludes (5.4 W-c, the embed gate's own
    // invariant) through a path that never calls upsertEntryVectors at all. Retire and forget it,
    // so this attempt behaves exactly as if no chunk had ever been embedded.
    if ((heldTags || alreadyHeld) && chunk) {
      await retireChunk();
      chunk = null;
    }

    if (readContent.length + suffix.length > CHUNK_MAX_CHARS) {
      // The whole text is re-embedded, so this commit must be of the text that was embedded.
      const newContent = readContent + suffix;
      // 5.4 W-c: no pre-commit re-embed for a held append — saves a model call, and the row is
      // never vectorized. Codex review class A (T-0089.4.2): also skipped for an append that
      // keeps an already-held row held (D4.1) — rowTags still carries the quarantine: tag.
      const newVectorIds = (heldTags || alreadyHeld) ? null : (await reembedOrDegrade(env, id, newContent, rowTags, source, config, embedCtx))?.vectorIds ?? null;
      // ADV-12: taken AFTER the embed, not before — a slow embed that lets a concurrent append commit
      // first must not stamp this later write with an earlier time than the one it lands on top of.
      const now = Date.now();
      const longCasColumns = { content: readContent, tags: readTags, workspace_id: pinnedWorkspaceId, vector_ids: row.vector_ids ?? null };
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
            entryId: id, reason: "append", change, content: { kind: "next", content: newContent }, nextTags: refreshedTags, nextWhen, meta: metaFor(eventId), now,
            // ADV-10: see updateEntryContent's identical reasoning above.
            priorLengthUtf16: readContent.length,
            guard: p2 => buildCasGuard(p2, longCasColumns),
          }),
          // updated_at clamped strictly past its own previous value, same reasoning as
          // updateEntryContent above (the digest mark guard trusts it plus byte length).
          // versioning: snapshot — vector_ids set here, atomically with content, under the same guard (ADV-4).
          env.DB.prepare(`UPDATE entries AS e SET content = ${contentIdx}, tags = ${tagsIdx}, updated_at = MAX(${nowIdx}, COALESCE(e.updated_at, e.created_at) + 1), vector_ids = ${vectorIdsIdx}${when ? `, when_at = ${whenIdx[0]}, when_kind = ${whenIdx[1]}, when_source = 'explicit'` : ""} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, longCasColumns)}`)
            .bind(...p.values()),
          pruneStatement(env, id, config.VERSION_KEEP),
          // 5.4 W-c: holdStatements appended to the same batch, guarded on this append's own
          // post-state so a lost compare-and-set cannot land the hold either.
          ...(heldTags && decision.hold ? holdStatements(env, { snapshotStatement, pruneStatement, versionKeep: config.VERSION_KEEP }, {
            entryId: id, reasons: decision.reasons, score: decision.score, signals: decision.signals, change, heldTags, now,
            guard: p2 => `content = ${p2.add(newContent)} AND tags = ${p2.add(JSON.stringify(refreshedTags))}`,
          }) : []),
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
        // Out of attempts: this attempt's upload is already discarded above.
        await retireChunk();
        throw new WriteConflictError();
      }
      // A short attempt earlier may have inserted a chunk this long commit re-embedded away.
      await retireChunk();

      if (heldTags) {
        // No new upload to compare stale ids against: delete the row's PRIOR vectors directly,
        // after commit, same as deprecateEntry (5.3 point 1).
        if (existingVectorIds.length) {
          try {
            await deleteEntryVectors(env, [{ entryId: id, vectorIds: existingVectorIds }]);
          } catch (e) {
            console.error("Vectorize delete failed after a held append (non-fatal):", e);
          }
        }
        await touchStandingIfNeeded(env, ctx, config, embedCtx.workspaceId, rowTags, refreshedTags);
        return { indexed: false, held: decision.hold ? { reasons: decision.reasons, score: decision.score } : undefined, wasCanonical, eventId };
      }

      // Skipped when Vectorize is unavailable: the old vectors are the entry's only remaining semantic index.
      if (newVectorIds) {
        try {
          await deleteStaleVectors(env, id, existingVectorIds, newVectorIds);
        } catch (e) {
          console.error("Old vector cleanup failed (non-fatal):", e);
        }
      }
      try {
        await inferEdgesOnWrite(id, await neighborsFromVectorQuery(await embed(addition, env, config), env), env);
      } catch (e) {
        console.error("Append auto-link failed (non-fatal):", e);
      }
      await touchStandingIfNeeded(env, ctx, config, embedCtx.workspaceId, rowTags, refreshedTags);
      return { indexed: newVectorIds !== null, wasCanonical, eventId };
    }

    // 5.4 W-c: a held append is never indexed — no chunk embed, no Vectorize insert. Codex
    // review class A (T-0089.4.2): also true for an append that keeps an already-held row held.
    if (!heldTags && !alreadyHeld && !chunk) {
      const values = await embed(addition, env, config);
      const [chunkId] = mintVectorIds(id, 1);
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
    const chunkId = chunk?.id ?? "";
    const indexed = chunk?.indexed ?? false;
    const values = chunk?.values ?? null;

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
          entryId: id, reason: "append", change, content: { kind: "suffix" }, nextTags: refreshedTags, nextWhen, meta: metaFor(eventId), now,
          // R2-1: NOT stamped here, unlike the long branch and updateEntryContent above — this
          // branch's guard (shortCasColumns) does not include content, so a concurrent short append
          // can land between this read and this commit, making readContent.length describe a state
          // shorter than what this version actually retires. buildChain falls back to its scan.
          guard: p => buildCasGuard(p, shortCasColumns),
        }),
        // versioning: snapshot — updated_at clamped, same reasoning as the long branch above.
        env.DB.prepare(
          `UPDATE entries AS e SET content = content || ${suffixIdx}, vector_ids = CASE WHEN ${indexedIdx} = 1 THEN json_insert(vector_ids, '$[#]', ${chunkIdx}) ELSE vector_ids END, tags = ${shortTagsIdx}, updated_at = MAX(${shortNowIdx}, COALESCE(e.updated_at, e.created_at) + 1)${when ? `, when_at = ${shortWhenIdx[0]}, when_kind = ${shortWhenIdx[1]}, when_source = 'explicit'` : ""} WHERE e.id = ${shortIdIdx} AND ${buildCasGuard(shortP, shortCasColumns)}`
        ).bind(...shortP.values()),
        pruneStatement(env, id, config.VERSION_KEEP),
        // 5.4 W-c: holdStatements appended to the same batch. The short branch's own guard is
        // tags + workspace only (R2-1, above), not content — this hold guard matches that: the
        // edit's own UPDATE unconditionally sets tags to refreshedTags on a match, so checking
        // tags = refreshedTags here still proves the edit landed, with no need to know the exact
        // resulting content (which a concurrent short append could also have touched).
        ...(heldTags && decision.hold ? holdStatements(env, { snapshotStatement, pruneStatement, versionKeep: config.VERSION_KEEP }, {
          entryId: id, reasons: decision.reasons, score: decision.score, signals: decision.signals, change, heldTags, now,
          guard: p2 => `tags = ${p2.add(JSON.stringify(refreshedTags))} AND workspace_id = ${p2.add(pinnedWorkspaceId)}`,
        }) : []),
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

    if (heldTags) {
      // The short branch never touches the row's EXISTING chunks — but held means vector_ids
      // ends at '[]', so every chunk the row had going in must go too, not just a new one.
      if (existingVectorIds.length) {
        try {
          await deleteEntryVectors(env, [{ entryId: id, vectorIds: existingVectorIds }]);
        } catch (e) {
          console.error("Vectorize delete failed after a held append (non-fatal):", e);
        }
      }
      await touchStandingIfNeeded(env, ctx, config, embedCtx.workspaceId, rowTags, refreshedTags);
      return { indexed: false, held: decision.hold ? { reasons: decision.reasons, score: decision.score } : undefined, wasCanonical, eventId };
    }

    try {
      await inferEdgesOnWrite(id, await neighborsFromVectorQuery(values!, env), env);
    } catch (e) {
      console.error("Append auto-link failed (non-fatal):", e);
    }
    await touchStandingIfNeeded(env, ctx, config, embedCtx.workspaceId, rowTags, refreshedTags, values ? [{ id, vector: values }] : undefined);
    return { indexed, wasCanonical, eventId };
  }
  throw new WriteConflictError();
}
