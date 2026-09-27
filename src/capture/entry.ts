import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { createEdge, inferEdgesOnWrite } from "../graph/edges";
import { getStatus, withStatus, type MemoryStatus } from "../memory/status";
import { extractHashtags } from "../text/hashtags";
import { classifyThenInfer, scheduleClassifyAndTag } from "./classify";
import { checkDuplicateAndContradiction } from "./duplicate";
import { deprecateEntry } from "./lifecycle";
import { auditEvent } from "../lib/audit";
import { deleteStaleVectors, embedContextForRow, reembedOrThrow, storeEntry } from "./store";
import { tagsAfterWrite } from "../memory/stale";
import { getVolatility, withVolatility } from "../memory/volatility";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { projectFilterSql } from "../projects/filter";
import type { ProjectRow } from "../projects/registry";
import { rememberTags } from "../tags/vocabulary";
import { CONFLICT_HELD_TAG, isCapsuleTag, SYSTEM_JOB_TAGS, USER_EDITED_TAG, withUserEditMarker } from "../tags/system";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import { SYSTEM_SOURCE, TRANSCRIPT_SOURCES } from "../constants";
import { deleteVectorIds } from "../vectorize/batch";
import type { WhenKind, WhenSource } from "../when/input";
import { extractUnambiguousDate } from "../when/heuristic";

export function buildEntryFilterQuery(params: {
  n: number;
  tag?: string;
  after?: number;
  before?: number;
  /**
   * A single resolved actor_id, already checked against the caller's roster by
   * resolveActorFilter (src/lib/actors.ts). One id, never a list: the filter has
   * to stay ONE predicate with ONE binding, because binding one parameter per
   * author is what put the author-label lookup over D1's 100-parameter ceiling
   * on a large team and 500'd the request.
   */
  actor?: string;
  /** Registry rows for one project: entries carrying its tag or any alias. ANDed with `tag`. */
  project?: readonly ProjectRow[];
}): { sql: string; bindings: (string | number)[] } {
  const conds: string[] = [];
  const bindings: (string | number)[] = [];
  // Escaped for the same reason as the recall path: `_` and `%` in a tag are LIKE
  // wildcards, so `#q3_planning` would also list `q3-planning` entries and `?tag=%` would
  // list everything. A read, so over-broad rather than destructive — but a filter that
  // silently stops filtering is worse than one that returns nothing.
  if (params.tag) { conds.push(`tags LIKE ? ${TAG_LIKE_ESCAPE}`); bindings.push(tagLikePattern(params.tag)); }
  if (params.project) {
    const project = projectFilterSql(params.project);
    conds.push(project.clause);
    bindings.push(...project.bindings);
  }
  // An equality on one id, ANDed with everything else including the caller's
  // scope clause — so it can only ever narrow what the scope already allowed.
  // Tested against undefined rather than truthiness for the reason the tag
  // comment above gives: `actor: ""` is the legacy authorless rows, a real and
  // narrow answer, and a filter that silently stops filtering and returns the
  // whole listing instead is the worst of the three outcomes.
  if (params.actor !== undefined) { conds.push(`actor_id = ?`); bindings.push(params.actor); }
  if (params.after !== undefined) { conds.push(`created_at >= ?`); bindings.push(params.after); }
  if (params.before !== undefined) { conds.push(`created_at <= ?`); bindings.push(params.before); }

  // scope-exempt: builder only: callers splice the caller's scope in before ORDER BY — routes/recall.ts always, but mcp/server.ts only `if (identity)`, so an identity-less MCP caller gets this SQL unscoped
  let sql = `SELECT id, content, tags, source, created_at, vector_ids, workspace_id, actor_id FROM entries`;
  if (conds.length) sql += ` WHERE ` + conds.join(` AND `);
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  bindings.push(params.n);

  return { sql, bindings };
}

export type CaptureResult =
  | { status: "blocked"; matchId: string; score: number }
  | { status: "stored"; id: string; tags: string[] }
  | { status: "flagged"; id: string; matchId: string; score: number }
  | { status: "contradiction"; id: string; resolvedConflict: string; reason?: string }
  | { status: "contradiction_protected"; id: string; canonicalId: string; entryStatus: MemoryStatus | null; reason?: string }
  | { status: "merged"; id: string }
  | { status: "replaced"; id: string };

/** Content and tags exactly as captureEntry stores them: trimmed, hashtags lifted into tags, tags lowercased and deduped. */
export function normalizeCaptureInput(rawContent: string, tags: string[]): { content: string; tags: string[] } {
  const raw = rawContent.trim();
  const { cleanContent, hashtags } = extractHashtags(raw);
  return {
    content: cleanContent || raw,
    tags: [...new Set([...tags.map(tag => tag.trim().toLowerCase()).filter(Boolean), ...hashtags])],
  };
}

export interface CaptureOptions {
  /**
   * A system job is writing, and which: the nightly "digest" or the weekly "insight".
   * It only ever merges into, replaces or deprecates a row of ITS OWN kind that a
   * system job wrote (`isSystemRow`). A user's or agent's memory, an edited digest,
   * and the other job's output are left untouched, and the newcomer is stored as its
   * own row, still flagged as a duplicate.
   */
  systemWrite?: SystemJob;
  /**
   * Audit channel for events the domain layer writes itself: "mcp", "rest" or
   * "system:<job>". Absent means the caller has no identity to attribute, and
   * no such event is written.
   */
  channel?: string;
}

export type SystemJob = keyof typeof SYSTEM_JOB_TAGS;

/**
 * A row THIS system job wrote and nobody has touched since: empty actor, the source
 * the jobs write, the job's own tag, no `user-edited` marker, and not a held or
 * draft or deprecated row (a digest stored because it contradicted something is not a live digest). Not the source
 * string alone, which any client can set through POST /capture or MCP remember; not
 * either system tag, which would let a digest overwrite an unreviewed insight.
 */
export function isSystemRow(row: { tags: string[]; actor_id?: unknown; source?: unknown }, job: SystemJob): boolean {
  return (row.actor_id ?? "") === ""
    && row.source === SYSTEM_SOURCE
    && row.tags.includes(SYSTEM_JOB_TAGS[job])
    && !row.tags.includes(USER_EDITED_TAG)
    && !row.tags.includes(CONFLICT_HELD_TAG)
    && getStatus(row.tags) !== "draft"
    && getStatus(row.tags) !== "deprecated";
}

/**
 * A system merge re-embedded a row and then lost it to a concurrent edit: the vectors under
 * that id now describe the system's text. Re-embed the row as it stands now and retire any
 * extra chunks the merge wrote. Best effort: the edit itself is safe in D1 either way.
 */
async function restoreRowVectors(
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
    console.error("Restoring vectors after a lost system merge failed (non-fatal):", e);
    // The row's vector_ids now names vectors holding the system's text. Emptying them makes
    // /vectorize-pending re-index the row from its own content, and the vectors go best-effort.
    try {
      await env.DB.prepare(
        // scope-exempt: by-id: the merge target this call just read under the write's own workspace
        `UPDATE entries SET vector_ids = '[]' WHERE id = ?`
      ).bind(id).run();
      await deleteVectorIds(env, [...new Set([...oldVectorIds, ...mergedVectorIds])]);
    } catch (e2) {
      console.error("Emptying vector_ids after a lost system merge failed (non-fatal):", e2);
    }
  }
}

export async function captureEntry(
  rawContent: string,
  tags: string[],
  source: string,
  env: Env,
  ctx: ExecutionContext,
  config?: Readonly<Config>,
  writeCtx: WriteContext = OWNER_WRITE_CONTEXT,
  // The time-anchor primitive (src/when/input.ts). Only ever set on the plain
  // "stored" INSERT below — a merged/replaced/protected write survives as an
  // EXISTING row with its own timing, which this does not touch.
  when?: { at: number; kind: WhenKind; source: WhenSource },
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  // Resolved once per capture and threaded through duplicate detection and
  // every embed below. Recall and capture must agree on EMBEDDING_MODEL or the
  // vectors they produce are not comparable.
  const cfg = config ?? await resolveConfig(env);
  const { content: c, tags: t } = normalizeCaptureInput(rawContent, tags);

  const { duplicate: dup, contradiction, mergeAction, neighbors } = await checkDuplicateAndContradiction(c, env, cfg, writeCtx.workspaceId, ctx);

  const definesCapsule = t.some(isCapsuleTag);
  if (definesCapsule && getStatus(t) === null) t.push("status:draft");

  if (dup.status === "blocked" && !definesCapsule) {
    return { status: "blocked", matchId: dup.matchId, score: dup.score };
  }

  // A capsule definition must land as its own row: a merge discards the
  // incoming tags, and the slot tags are the whole point of the write.
  if (dup.status === "flagged" && mergeAction && mergeAction.action !== "keep_both" && !definesCapsule) {
    const targetId = mergeAction.target_id;
    const newContent = mergeAction.action === "merge" ? mergeAction.merged_content : c;

    const targetRow = await env.DB.prepare(
      // Pinned to the WRITER's workspace, not read back from the row: a share or move after the
      // scoped candidate read must make this a lost race (null row), never a merge in the new workspace.
      `SELECT content, tags, source, vector_ids, importance_score, actor_id, workspace_id FROM entries WHERE id = ? AND workspace_id = ?`
    ).bind(targetId, writeCtx.workspaceId).first() as Record<string, any> | null;

    if (targetRow) {
      const existingTags: string[] = JSON.parse(targetRow.tags ?? "[]");
      const existingContent = targetRow.content as string;
      const existingSource = targetRow.source as string;
      const oldVectorIds: string[] = JSON.parse(targetRow.vector_ids ?? "[]");

      const targetStatus = getStatus(existingTags);
      // A protected target is left alone and the newcomer is STORED below as a
      // duplicate-candidate. This branch used to `return` a random id here
      // without inserting anything, so the route reported success for a row
      // that did not exist (#327 review). The third clause is the transcript
      // rule from TRANSCRIPT_SOURCES.
      const protectedTarget =
        (targetRow.importance_score as number) >= 4
        || targetStatus === "canonical"
        || (TRANSCRIPT_SOURCES.has(source) && existingSource !== source)
        // A system job merges only into what a system job wrote.
        || (opts.systemWrite !== undefined && !isSystemRow({ tags: existingTags, actor_id: targetRow.actor_id, source: existingSource }, opts.systemWrite));

      if (!protectedTarget) {
        let newVectorIds: string[] | null = null;
        try {
          newVectorIds = (await reembedOrThrow(env, targetId, newContent, existingTags, existingSource, cfg, writeCtx)).vectorIds;
        } catch (e) {
          console.error("Merge re-embed failed — keeping both, target untouched:", e);
        }

        if (newVectorIds) {
          // The rest of the incoming tag list is deliberately discarded on a merge, which
          // predates this and is left alone — but the volatility verdict cannot be, because
          // it is the one value the tool schema tells the caller wins permanently. Dropping
          // it here reported "merged" on a write that silently threw the judgment away, and
          // the merge bumps updated_at, so the nightly pass would not revisit the entry for
          // 90 days to re-derive anything. The caller judged the content being merged in, so
          // its verdict describes the combined body more recently than the target's does.
          const incomingVerdict = getVolatility(t);
          const stripped = tagsAfterWrite(existingTags);
          const verdictTags = incomingVerdict ? withVolatility(stripped, incomingVerdict) : stripped;
          // A person's capture merging into a digest or insight makes it theirs (a system
          // job merging into its own row does not).
          const refreshedTags = opts.systemWrite ? verdictTags : withUserEditMarker(verdictTags);
          const now = Date.now();
          // A system merge commits only if the row is still what was read: a person's edit can land
          // during the re-embed above, and their text and `user-edited` marker must not be overwritten.
          const cas = opts.systemWrite !== undefined;
          const committed = cas
            ? await env.DB.prepare(
              // scope-exempt: by-id: the merge target read above under this write's workspace, compare-and-set on the workspace, system-row identity, tags and content read
              `UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ? AND tags = ? AND content = ? AND workspace_id = ? AND COALESCE(actor_id, '') = '' AND source = ?`)
              .bind(newContent, JSON.stringify(refreshedTags), now, targetId, targetRow.tags ?? "[]", existingContent, writeCtx.workspaceId, existingSource).run()
            : await env.DB.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ?`)
              .bind(newContent, JSON.stringify(refreshedTags), now, targetId).run();
          if (cas && (committed.meta.changes ?? committed.meta.rows_written ?? 0) === 0) {
            console.error("System merge lost the row to a concurrent edit — keeping both");
            await restoreRowVectors(env, targetId, oldVectorIds, newVectorIds, existingSource, cfg, writeCtx);
          } else {
            try {
              await deleteStaleVectors(env, oldVectorIds, newVectorIds);
            } catch (e) { console.error("Old vector cleanup failed (non-fatal):", e); }

            // The survivor's content just changed, so its graph position should
            // too. `neighbors` is the answer duplicate detection already got from
            // Vectorize for this same text, reused rather than asked again — the
            // merge therefore adds no query and no embed of its own.
            // inferEdgesOnWrite drops the written id from its own candidates, so
            // the target needs no filtering. dup.matchId does: the model picks the
            // merge target and is free to choose the SECOND-best match, leaving
            // the closest near-duplicate in `neighbors` — and linking the survivor
            // to that is the junk edge suppression exists to prevent, arriving by
            // a different door.
            classifyThenInfer(targetId, newContent, env, ctx, cfg, kind =>
              inferEdgesOnWrite(targetId, neighbors, env, { suppressId: dup.matchId, newKind: kind }));

            return mergeAction.action === "merge"
              ? { status: "merged", id: targetId }
              : { status: "replaced", id: targetId };
          }
        }
      }
    }
  }

  // 公開可否をINSERT前に確定し、同時に読むgatewayへ矛盾したprefixを見せない。
  let protectConflict = false;
  let conflictSnapshot: Record<string, any> | null = null;
  if (contradiction.detected && contradiction.conflicting_id) {
    const conflictRow = await env.DB.prepare(
      // Pinned to the WRITER's workspace, like the merge read above: a row moved since the scoped
      // read comes back null, which a system job treats as "not mine to deprecate".
      `SELECT content, tags, source, actor_id, workspace_id, vector_ids FROM entries WHERE id = ? AND workspace_id = ?`
    ).bind(contradiction.conflicting_id, writeCtx.workspaceId).first() as Record<string, any> | null;
    conflictSnapshot = conflictRow;
    const conflictTags: string[] = conflictRow ? JSON.parse(conflictRow.tags ?? "[]") : [];
    const conflictStatus = conflictRow ? getStatus(conflictTags) : null;
    const conflictSource = conflictRow ? String(conflictRow.source ?? "") : "";
    // Canonical memories were always protected here. A transcript gets the same
    // treatment against any memory of another source: the newcomer becomes a
    // draft and nothing is deprecated, because "we decided X… actually Y" in a
    // session log is not evidence that the memory of X is wrong.
    protectConflict =
      // The row is no longer in the writer's workspace (moved, shared or forgotten since the scoped
      // read): whoever wrote it has decided where it lives, and this write may not rule on it.
      !conflictRow
      || conflictStatus === "canonical"
      || (TRANSCRIPT_SOURCES.has(source) && conflictSource !== source)
      // A system job never rewrites a row it did not write, deprecation included.
      || (opts.systemWrite !== undefined && !isSystemRow({ tags: conflictTags, actor_id: conflictRow?.actor_id, source: conflictSource }, opts.systemWrite));

  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const baseTags = contradiction.detected ? [...t, "contradiction-resolved"] : t;
  const duplicateTags = dup.status === "flagged" ? [...baseTags, "duplicate-candidate"] : baseTags;
  const finalTags = protectConflict
    ? withStatus(duplicateTags.filter(tag => tag !== "contradiction-resolved"), "draft")
    : duplicateTags;

  // The caller's own `when` always wins. Absent one, a cheap regex pass looks
  // for an unambiguous future date already in the text — negligible CPU, no
  // model call — and only ever claims a date nobody could dispute; anything
  // fuzzier is src/when/pass.ts's job, on a budget, at night.
  const resolvedWhen = when ?? (() => {
    const at = extractUnambiguousDate(c, now, cfg.TIMEZONE);
    return at !== null ? { at, kind: "due" as WhenKind, source: "regex" as WhenSource } : undefined;
  })();

  await env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, c, JSON.stringify(finalTags), source, now, now, "[]", writeCtx.workspaceId, writeCtx.actorId,
    resolvedWhen?.at ?? null, resolvedWhen?.kind ?? null, resolvedWhen?.source ?? null,
  ).run();

  // Indexed once the outcome is known, with the tags the row will actually keep: a system capture can
  // still be turned into a held draft by a lost compare-and-set below.
  const scheduleIndex = (indexTags: string[]) => ctx.waitUntil(
    storeEntry(env, id, c, indexTags, source, now, cfg, writeCtx)
      .catch(e => console.error("Vectorize insert failed (non-fatal):", e))
  );

  // Capture is where a tag string nobody wrote into the source first exists, so it is
  // one of the two places the cached vocabulary has to learn one (#288). Deferred, so
  // the capture does not wait on KV — which means the tag is admitted once this
  // settles rather than by the time the response lands, and a `GET /tags` fired
  // straight off the back of the save can miss it by one refresh.
  ctx.waitUntil(rememberTags(env, finalTags, writeCtx.workspaceId));

  // A flagged capture is a near-duplicate the writer chose to keep, so the
  // entry it duplicates is its top neighbour by construction. Linking them
  // spends an inference slot restating the duplicate-candidate tag.
  const suppressId = dup.status === "flagged" ? dup.matchId : undefined;

  if (contradiction.detected && contradiction.conflicting_id) {
    const conflictId = contradiction.conflicting_id;

    const keepAsDraft = async (): Promise<CaptureResult> => {
      const draftTags = finalTags.filter(t => t !== "contradiction-resolved");
      // Contradictory definitions must not publish into a prompt prefix.
      const heldTags = withStatus(draftTags, "draft");
      // A system job's draft is held: no later system job may supersede, merge into or replace it.
      const protectedTags = opts.systemWrite !== undefined && !heldTags.includes(CONFLICT_HELD_TAG)
        ? [...heldTags, CONFLICT_HELD_TAG] : heldTags;
      scheduleIndex(protectedTags);
      await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`)
        .bind(JSON.stringify(protectedTags), id).run();
      // A system job's guess must not move the user's row: a win here would make it
      // permanently ineligible for digests (compression/eligibility.ts).
      if (opts.systemWrite === undefined && conflictSnapshot) {
        try {
          await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1 WHERE id = ?`).bind(conflictId).run();
          await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1 WHERE id = ?`).bind(id).run();
        } catch (e) {
          console.error("Contradiction count update failed (non-fatal):", e);
        }
      }
      // This path draws no edges, so there is nothing to chain onto.
      scheduleClassifyAndTag(id, c, env, ctx, cfg);
      return {
        status: "contradiction_protected",
        id,
        canonicalId: conflictId,
        entryStatus: getStatus(protectedTags),
        reason: contradiction.reason,
      };
    };

    if (protectConflict) return keepAsDraft();

    // A system job deprecates only a row that is STILL the system row it read: same workspace,
    // actor, source, tags and content. A person's edit or a share/unshare since then wins.
    let deprecatedBySystem = false;
    if (opts.systemWrite !== undefined && conflictSnapshot) {
      const snap = conflictSnapshot;
      const res = await env.DB.prepare(
        // scope-exempt: by-id: compare-and-set on the row read above; workspace_id = the WRITER's workspace is in the predicate
        `UPDATE entries SET tags = ?, vector_ids = '[]' WHERE id = ? AND tags = ? AND content = ? AND workspace_id = ? AND COALESCE(actor_id, '') = '' AND source = ?`
      ).bind(
        JSON.stringify(withStatus(JSON.parse(snap.tags ?? "[]"), "deprecated")), conflictId,
        snap.tags ?? "[]", snap.content, writeCtx.workspaceId, snap.source,
      ).run();
      if ((res.meta.changes ?? res.meta.rows_written ?? 0) === 0) return keepAsDraft();
      deprecatedBySystem = true;
      try {
        const oldVectorIds: string[] = JSON.parse(snap.vector_ids ?? "[]");
        if (oldVectorIds.length) await deleteVectorIds(env, oldVectorIds);
      } catch (e) { console.error("Vectorize deleteByIds failed during deprecate (non-fatal):", e); }
      if (opts.channel) {
        auditEvent(env, ctx, {
          entryId: conflictId,
          actorId: writeCtx.actorId,
          event: "status_changed",
          payload: { status: "deprecated", reason: "contradiction", newEntryId: id, channel: opts.channel },
        });
      }
    }

    scheduleIndex(finalTags);
    // The user path deprecates by id, pinned to the writer's workspace; if the row is no longer
    // there this was not a contradiction this write may rule on: keep the newcomer, no counters, no edge.
    let deprecated = deprecatedBySystem;
    if (!deprecatedBySystem) {
      try {
        deprecated = await deprecateEntry(conflictId, env, writeCtx.workspaceId);
        if (deprecated && opts.channel) {
          auditEvent(env, ctx, {
            entryId: conflictId,
            actorId: writeCtx.actorId,
            event: "status_changed",
            payload: { status: "deprecated", reason: "contradiction", newEntryId: id, channel: opts.channel },
          });
        }
      } catch (e) {
        console.error("Contradiction deprecation failed (non-fatal):", e);
      }
    }
    if (!deprecated) {
      classifyThenInfer(id, c, env, ctx, cfg, kind =>
        inferEdgesOnWrite(id, neighbors, env, { suppressId, newKind: kind }));
      return { status: "stored", id, tags: finalTags };
    }
    try {
      await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1 WHERE id = ?`).bind(id).run();
      await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1 WHERE id = ?`).bind(conflictId).run();
    } catch (e) {
      console.error("Contradiction count update failed (non-fatal):", e);
    }
    try {
      // Stamped with the workspace this capture was written to, for the same
      // reason POST /link and the MCP link tool stamp theirs: edges.workspace_id
      // has no default worth having — it falls back to "", the legacy/system
      // space, which readableWorkspaces grants to ADMINS ONLY. An edge left
      // there is one the member whose capture drew it can never see in their own
      // graph. writeCtx is already the resolved answer to "which workspace did
      // this entry land in", so no second lookup is needed.
      await createEdge(id, conflictId, "supersedes", { provenance: "system", weight: 1.0, workspaceId: writeCtx.workspaceId }, env);
    } catch (e) {
      console.error("Supersedes edge creation failed (non-fatal):", e);
    }
    classifyThenInfer(id, c, env, ctx, cfg, kind =>
      inferEdgesOnWrite(id, neighbors.filter(n => n.id !== conflictId), env, { suppressId, newKind: kind }));
    return { status: "contradiction", id, resolvedConflict: conflictId, reason: contradiction.reason };
  }

  scheduleIndex(finalTags);
  classifyThenInfer(id, c, env, ctx, cfg, kind =>
    inferEdgesOnWrite(id, neighbors, env, { suppressId, newKind: kind }));

  if (dup.status === "flagged") {
    return { status: "flagged", id, matchId: dup.matchId, score: dup.score };
  }

  // finalTags is what actually landed on the row — hashtags pulled out of the
  // content, plus anything the caller passed. The dashboard shows it back as a
  // capture receipt, so a person can see what the brain did with what they
  // wrote rather than trusting it silently.
  return { status: "stored", id, tags: finalTags };
}
