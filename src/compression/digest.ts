import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { captureEntry } from "../capture/entry";
import { DIGEST_MAX_TOKENS, LLM_MODEL } from "../constants";
import { readStreamText } from "../lib/ai";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { MAX_PROJECT_PATTERNS, expandProjectFilter, projectFilterSql } from "../projects/filter";
import type { ProjectRow } from "../projects/registry";
import { PROJECT_TAG_PREFIX } from "../tags/system";
import {
  compressionEligibilitySql,
  isTopicTag,
} from "./eligibility";

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

/** Mark digest sources and retry individually if the batch fails. */
async function markSourcesRolledUp(env: Env, ids: string[], digestId: string): Promise<void> {
  if (!ids.length) return;
  const note = `\n\n[Digest: ${digestId}]`;
  const mark = (id: string) => env.DB.prepare(
    `UPDATE entries SET tags = json_insert(tags, '$[#]', 'rolled-up'), content = content || ? WHERE id = ?`
  ).bind(note, id);

  try {
    await env.DB.batch(ids.map(mark));
  } catch (e) {
    console.error("Batched rolled-up mark failed; retrying per row (non-fatal):", e);
    for (const id of ids) {
      try {
        await mark(id).run();
      } catch (err) {
        console.error(`Failed to update source entry ${id} (non-fatal):`, err);
      }
    }
  }
}

export interface CompressTagOptions {
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

    const rows = rawEntries.map(r => ({ id: r.id as string, content: r.content as string }));
    const label = workspaceRows?.[0].name;
    const digestText = await synthesizeDigest(tag, rows, env, cfg, label);
    if (!digestText) continue;

    const provenance = label === undefined ? `tagged "${tag}"` : `in project "${label}"`;
    const content = `[Synthesized from ${rows.length} entries ${provenance}]\n\n${digestText}`;
    // The digest inherits the partition's workspace and keeps actor "" — system-
    // authored, like every pre-team pipeline row.
    const result = await captureEntry(content, ["synthesized", tag], "system", env, ctx, cfg,
      { workspaceId, actorId: "" });

    if (result.status !== "stored") {
      continue;
    }

    await markSourcesRolledUp(env, rows.map(r => r.id), result.id);

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
