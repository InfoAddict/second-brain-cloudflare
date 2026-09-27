import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { captureEntry } from "../capture/entry";
import { DIGEST_MAX_TOKENS, LLM_MODEL, SYSTEM_SOURCE } from "../constants";
import { readStreamText } from "../lib/ai";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { MAX_PROJECT_PATTERNS, expandProjectFilter, projectFilterSql } from "../projects/filter";
import type { ProjectRow } from "../projects/registry";
import { PROJECT_TAG_PREFIX } from "../tags/system";
import {
  compressionEligibilitySql,
  isTopicTag,
} from "./eligibility";
import type { ChangeContext } from "../lib/audit";
import { pruneManyStatement, pruneStatement, snapshotStatement } from "../memory/versions";

export async function synthesizeDigest(
  tag: string,
  rows: { id: string; content: string }[],
  env: Env,
  config: Readonly<Config> = DEFAULTS,
  /** A project digest's display name; the key itself (project:<slug>) is never shown. */
  label?: string,
): Promise<string> {
  if (!rows.length) return "";

  const memoriesList = rows
    .map((r, i) => `[${i + 1}] ${r.content.slice(0, 400)}`)
    .join("\n\n");

  const subject = label === undefined ? `tagged "${tag}"` : `in the project "${label}"`;
  const stateOf = label === undefined ? `"${tag}"` : `the project "${label}"`;
  const prompt = `You are a second brain assistant. Based on these stored memories ${subject}, write a single cohesive paragraph describing the current state of this area — what has been done, decided, and is being worked toward. Write as one flowing paragraph, not a list.

Memories:
${memoriesList}

State of ${stateOf}:`;

  let digest = "";
  try {
    const stream = await (env.AI as any).run(config.LLM_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: DIGEST_MAX_TOKENS,
      stream: true,
    });
    digest = await readStreamText(stream as ReadableStream);
  } catch (e) {
    console.error("synthesizeDigest LLM call failed (non-fatal):", e);
  }

  return digest.trim();
}

/**
 * Mark digest sources and retry individually if the batch fails. Versioned: a rollup can be undone.
 *
 * Both the mark's WHERE and the snapshot's guard are built from the same {workspaceId, content}
 * per source (P3: a snapshot of a CAS-guarded write carries the same guard), so they cannot drift.
 * `content` is the text this source held when the digest actually read it, before synthesis: a
 * source that moved workspace mid-run, or whose text changed mid-run, misses the mark AND the
 * version — a phantom rollup version, stamped with the wrong workspace or over text the digest
 * never saw, would give it a 0.4x recall penalty and bar it from every future digest.
 */
async function markSourcesRolledUp(env: Env, sources: { id: string; content: string }[], digestId: string, workspaceId: string, config: Readonly<Config>): Promise<void> {
  if (!sources.length) return;
  const note = `\n\n[Digest: ${digestId}]`;
  const change: ChangeContext = { actorId: "", channel: "system:digest" };
  const now = Date.now();
  const ids = sources.map(s => s.id);
  // versioning: snapshot
  const mark = (id: string, content: string) => env.DB.prepare(
    `UPDATE entries SET tags = json_insert(tags, '$[#]', 'rolled-up'), content = content || ? WHERE id = ? AND workspace_id = ? AND content = ?`
  ).bind(note, id, workspaceId, content);
  // nextTags is unused for a "suffix" content kind (the version's tags column comes from e.tags
  // directly); passed empty rather than reading the row again just for this.
  const snapshotFor = (id: string, content: string) => snapshotStatement(env, {
    entryId: id, reason: "rollup", change, content: { kind: "suffix" }, nextTags: [], meta: { digestId }, now,
    guard: p => `e.workspace_id = ${p.add(workspaceId)} AND e.content = ${p.add(content)}`,
  });

  try {
    await env.DB.batch([
      ...sources.flatMap(({ id, content }) => [snapshotFor(id, content), mark(id, content)]),
      pruneManyStatement(env, ids, config.VERSION_KEEP),
    ]);
  } catch (e) {
    console.error("Batched rolled-up mark failed; retrying per row (non-fatal):", e);
    for (const { id, content } of sources) {
      try {
        await env.DB.batch([
          snapshotFor(id, content),
          mark(id, content),
          pruneStatement(env, id, config.VERSION_KEEP),
        ]);
      } catch (err) {
        console.error(`Failed to update source entry ${id} (non-fatal):`, err);
      }
    }
  }
}

/**
 * A digest held as a draft (it contradicted a memory a system job may not rewrite) that is still
 * LIVE in one workspace for one tag. Bound: workspace id, then the tag's LIKE pattern.
 *
 * The `instr(lower(tags), '"conflict-held"') > 0` predicate is what makes the partial index
 * idx_entries_conflict_held usable, so the check reads only held rows, never the workspace
 * (test/unit/compress-held-plan.test.ts). This per-tag form serves a manual digest; the nightly run
 * reads every workspace's held set once (heldDigestSet) and passes it in. It runs only on the path
 * that would otherwise pay for a model call, after the cooldown and the source count.
 *
 * It releases when the person acts on the draft: edits it (`user-edited`), confirms it (status
 * canonical), deprecates it, or forgets it (the row is gone).
 */
export const heldDigestSql = (indexed: boolean): string => `
  SELECT id FROM entries${indexed ? " INDEXED BY idx_entries_conflict_held" : ""}
  WHERE instr(lower(tags), '"conflict-held"') > 0
    AND workspace_id = ?
    AND tags LIKE ? ${TAG_LIKE_ESCAPE}
    AND tags NOT LIKE '%"user-edited"%'
    AND tags NOT LIKE '%"status:canonical"%'
    AND tags NOT LIKE '%"status:deprecated"%'
  LIMIT 1`;

/**
 * Is a held draft for this tag still waiting on the person? Forced onto the partial index, which
 * SQLite will not otherwise pick over the workspace index; a brain that has not built it yet
 * (`no such index`) retries once without the hint, as GET /projects does.
 */
async function hasHeldDigest(env: Env, workspaceId: string, tag: string): Promise<boolean> {
  try {
    return Boolean(await env.DB.prepare(heldDigestSql(true)).bind(workspaceId, tagLikePattern(tag)).first());
  } catch (e) {
    if (!/no such index: idx_entries_conflict_held/i.test(String((e as Error)?.message ?? e))) throw e;
    return Boolean(await env.DB.prepare(heldDigestSql(false)).bind(workspaceId, tagLikePattern(tag)).first());
  }
}

/** The key `heldDigestSet` holds a (workspace, tag) pair under. */
export const heldKey = (workspaceId: string, tag: string): string => `${workspaceId}\u0000${tag}`;

/** Most held digests one read returns. A read that comes back full may be incomplete, so callers treat it as unknown. */
export const HELD_DIGESTS_READ_LIMIT = 500;

/**
 * The read behind `heldDigestSet`: the held digests that are still live, as (workspace, tags) rows.
 * `workspaceId` narrows it to that workspace's slice; null reads every workspace (the corpus-wide
 * cron scan). Bounded by HELD_DIGESTS_READ_LIMIT: a held digest is at most one per tag and workspace, but holds never expire on their own.
 * Exported so the nightly run can ride it in the batch it already sends for its candidates.
 */
export function prepareHeldDigests(env: Env, workspaceId: string | null, indexed = true): D1PreparedStatement {
  // scope-exempt: cron: held-draft existence read for the nightly rollup; the workspace slice, when the run has one, is in the predicate, and only (workspace, tag) names are used, never content
  const sql = `
    SELECT workspace_id, tags FROM entries${indexed ? " INDEXED BY idx_entries_conflict_held" : ""}
    WHERE instr(lower(tags), '"conflict-held"') > 0
      AND tags LIKE '%"synthesized"%'
      AND tags NOT LIKE '%"user-edited"%'
      AND tags NOT LIKE '%"status:canonical"%'
      AND tags NOT LIKE '%"status:deprecated"%'${workspaceId === null ? "" : "\n      AND workspace_id = ?"}
    LIMIT ${HELD_DIGESTS_READ_LIMIT}`;
  return env.DB.prepare(sql).bind(...(workspaceId === null ? [] : [workspaceId]));
}

/** The set of `heldKey(workspace, tag)` for every tag on the rows prepareHeldDigests returned. */
export function heldSetFrom(rows: readonly Record<string, unknown>[] | undefined): Set<string> {
  const held = new Set<string>();
  for (const row of rows ?? []) {
    let tags: unknown;
    try { tags = JSON.parse(String(row.tags ?? "[]")); } catch { continue; }
    if (!Array.isArray(tags)) continue;
    for (const t of tags) if (typeof t === "string") held.add(heldKey(String(row.workspace_id ?? ""), t));
  }
  return held;
}

/** Same read on its own, with the index hint and the `no such index` retry of hasHeldDigest. */
export async function heldDigestSet(env: Env, workspaceId: string | null): Promise<Set<string>> {
  try {
    return heldSetFrom((await prepareHeldDigests(env, workspaceId, true).all<Record<string, unknown>>()).results);
  } catch (e) {
    if (!/no such index: idx_entries_conflict_held/i.test(String((e as Error)?.message ?? e))) throw e;
    return heldSetFrom((await prepareHeldDigests(env, workspaceId, false).all<Record<string, unknown>>()).results);
  }
}

export interface CompressTagOptions {
  /**
   * The (workspace, tag) pairs with a live held digest, already read once for the whole run
   * (heldDigestSet). Absent, compressTag asks per tag, as a manual digest does.
   */
  heldDigests?: ReadonlySet<string>;
  /** When set, roll up only these workspaces and scope the 24h cooldown per workspace. */
  workspaceIds?: string[];
  /**
   * Registry-driven project digest: `tag` is `project:<slug>`, and members are the entries
   * carrying that tag or any alias in these rows (all rows for the one slug). Each workspace
   * is rolled up with ITS OWN row only, so one workspace's aliases never reach another's
   * entries. The `project:` namespace is otherwise refused as a topic, so only a registry row
   * can open this door.
   */
  project?: readonly ProjectRow[];
}

export async function compressTag(
  tag: string,
  env: Env,
  ctx: ExecutionContext,
  opts?: CompressTagOptions,
): Promise<{ synthesizedId: string | null; entriesUsed: number; text: string }> {
  // Reject bookkeeping tags before the configuration lookup. A project digest is the one
  // exception, and only when the key really is that project's own tag.
  const projectRows = opts?.project?.length ? opts.project : undefined;
  if (projectRows ? tag !== `${PROJECT_TAG_PREFIX}${projectRows[0].id}` : !isTopicTag(tag)) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }
  const cfg = await resolveConfig(env);

  // Select and summarize one workspace at a time so private memories cannot be
  // pooled into a digest visible from another workspace.
  const scoped = Boolean(opts?.workspaceIds?.length);
  let workspaces: string[];
  if (scoped) {
    workspaces = opts!.workspaceIds!;
  } else {
    const { results: workspaceRows } = await env.DB.prepare(
      // scope-exempt: cron: workspace discovery for the partitioned rollup below; returns workspace ids, never a row's content
      `SELECT DISTINCT workspace_id FROM entries`
    ).all();
    workspaces = (workspaceRows as { workspace_id?: string }[]).map(r => r.workspace_id ?? "");
    if (!workspaces.length) workspaces.push("");
  }

  let synthesizedId: string | null = null;
  let entriesUsed = 0;
  let text = "";

  for (const workspaceId of workspaces) {
    // The rollup is destructive, so a project's filter is built from this workspace's row
    // alone; a workspace without a row has no such project.
    const workspaceRows = projectRows?.filter(r => r.workspace_id === workspaceId);
    if (workspaceRows) {
      if (!workspaceRows.length) continue;
      if (expandProjectFilter(workspaceRows).patterns.length > MAX_PROJECT_PATTERNS) {
        console.warn(`Skipping digest of ${tag}: more than ${MAX_PROJECT_PATTERNS} tag patterns in workspace "${workspaceId}"`);
        continue;
      }
    }

    // The 24h cooldown stays corpus-wide on purpose for the nightly cron: it gates
    // repetition, not visibility, so checking it across workspaces can only ever
    // postpone a digest by a day — it never moves one user's content into another
    // user's row. Manual GET /digest passes workspaceIds and gets a per-workspace
    // check instead, so one member's recent rollup does not block another's.
    let recentSynth: { id?: string } | null;
    if (scoped) {
      recentSynth = await env.DB.prepare(`
        SELECT id FROM entries
        WHERE tags LIKE '%"synthesized"%'
          AND tags LIKE ? ${TAG_LIKE_ESCAPE}
          AND created_at > ?
          AND workspace_id = ?
        LIMIT 1
      `).bind(tagLikePattern(tag), Date.now() - 86400000, workspaceId).first();
    } else {
      // scope-exempt: cron: corpus-wide 24h cooldown existence check — id only, never returned; couples tenants on tag name only, no content crosses
      recentSynth = await env.DB.prepare(`
        SELECT id FROM entries
        WHERE tags LIKE '%"synthesized"%'
          AND tags LIKE ? ${TAG_LIKE_ESCAPE}
          AND created_at > ?
        LIMIT 1
      `).bind(tagLikePattern(tag), Date.now() - 86400000).first();
    }

    if (recentSynth) {
      continue;
    }


    const member = workspaceRows
      ? projectFilterSql(workspaceRows)
      : { clause: `tags LIKE ? ${TAG_LIKE_ESCAPE}`, bindings: [tagLikePattern(tag)] };
    const { results: rawEntries } = await env.DB.prepare(`
      SELECT id, content FROM entries
      WHERE ${member.clause}
        AND tags NOT LIKE '%"synthesized"%'
        AND tags NOT LIKE '%"auto-pattern"%'
        AND tags NOT LIKE '%"auto-insight"%'
        AND tags NOT LIKE '%"rolled-up"%'
        AND tags NOT LIKE '%"capsule:%'
        AND tags NOT LIKE '%"capsule-slot:%'
        AND ${compressionEligibilitySql("", cfg)}
        AND workspace_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).bind(...member.bindings, Date.now() - cfg.COMPRESSION_MIN_AGE_MS, workspaceId).all();

    if (rawEntries.length < 10) {
      continue;
    }

    // A held draft for this tag is not retried every cycle: the same sources would be re-summarised,
    // and the model paid for, only to be held again. See heldDigestSql for when it releases.
    if (opts?.heldDigests ? opts.heldDigests.has(heldKey(workspaceId, tag)) : await hasHeldDigest(env, workspaceId, tag)) {
      continue;
    }

    const rows = rawEntries.map(r => ({ id: r.id as string, content: r.content as string }));
    const label = workspaceRows?.[0].name;
    const digestText = await synthesizeDigest(tag, rows, env, cfg, label);
    if (!digestText) continue;

    const provenance = label === undefined ? `tagged "${tag}"` : `in project "${label}"`;
    const content = `[Synthesized from ${rows.length} entries ${provenance}]\n\n${digestText}`;
    // The digest inherits the partition's workspace and keeps actor "" — system-
    // authored, like every pre-team pipeline row.
    const result = await captureEntry(content, ["synthesized", tag], SYSTEM_SOURCE, env, ctx, cfg,
      { workspaceId, actorId: "" }, undefined, { systemWrite: "digest", channel: "system:digest" });

    // Only a blocked capture wrote nothing. Every other status (flagged, contradiction,
    // contradiction_protected, merged, replaced) left a row that holds these sources'
    // digest, so they roll up onto it; skipping them would re-digest the same sources
    // into a fresh near-duplicate every cooldown.
    if (result.status === "blocked") {
      continue;
    }
    // A protected draft is not a live digest: rolling sources up onto it would penalise and
    // rewrite user memories for a summary recall never shows. The digest retries next cycle.
    if (result.status === "contradiction_protected") {
      continue;
    }

    await markSourcesRolledUp(env, rows, result.id, workspaceId, cfg);

    // First successful digest defines the returned text/id; counts accumulate across
    // workspaces so a caller still learns how much was compressed tonight.
    if (!synthesizedId) {
      synthesizedId = result.id;
      text = digestText;
    }
    entriesUsed += rows.length;
  }

  return { synthesizedId, entriesUsed, text };
}
