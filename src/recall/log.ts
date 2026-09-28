/**
 * T-0089.5.2: the sampled recall log (Part A, feeding the golden eval set T-0043) and
 * implicit feedback from what agents already do (Part B), without a per-read D1 write.
 *
 * Opt-in via config RECALL_LOG, off by default everywhere (D5.2) — the log holds the
 * user's own query text, in the user's own D1, never exported by default. Both entry
 * points are called at most once per recall/get/append/update/link (search.ts and the
 * MCP/REST handlers each call one of them), and both are safe to await inside
 * `ctx.waitUntil`: neither throws, and neither affects what the caller already returned.
 */
import type { Env } from "../env";
import type { Config } from "../config";
import { RECALL_LOG_FOLLOW_WINDOW_MS, RECALL_LOG_PER_DAY, RECALL_LOG_PURGE_BATCH, RECALL_LOG_RETENTION_DAYS } from "../constants";

export type RecallLogChannel = "mcp" | "rest";

export interface RecallLogInput {
  workspaceId: string;
  channel: RecallLogChannel;
  /** The raw query text — this is what makes the log opt-in (D5.2), not a hash or summary. */
  query: string;
  /** topK, filters (tag/kind/date/project) and hops, serialised as-is. */
  params: unknown;
  returnedIds: readonly string[];
  now: number;
}

function dayNumber(now: number): number {
  return Math.floor(now / 86400000);
}

function counterKey(workspaceId: string, now: number): string {
  return `recall-log-count:${workspaceId}:${dayNumber(now)}`;
}

/**
 * Logs at most RECALL_LOG_PER_DAY recalls per workspace per day (D5.2 gate: only when
 * RECALL_LOG is "on"). The cap is enforced by a KV counter read before any D1 write, so a
 * workspace already over budget costs one KV read and nothing else — no D1 read, no D1
 * write. A logged recall also purges up to RECALL_LOG_PURGE_BATCH rows past the retention
 * window, oldest first, so the table never grows past what the day cap plus retention
 * imply.
 */
export async function maybeLogRecall(env: Env, cfg: Config, input: RecallLogInput): Promise<void> {
  if (cfg.RECALL_LOG !== "on") return;
  try {
    const key = counterKey(input.workspaceId, input.now);
    const countRaw = await env.OAUTH_KV.get(key);
    const count = countRaw ? Number(countRaw) : 0;
    if (!(count < RECALL_LOG_PER_DAY)) return;
    // A day past the boundary this key is keyed on, so a slow clock or a KV read racing
    // the day rollover cannot let the counter linger and silently cap the next day too.
    await env.OAUTH_KV.put(key, String(count + 1), { expirationTtl: 2 * 86400 });

    const cutoff = input.now - RECALL_LOG_RETENTION_DAYS * 86400000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO recall_log (id, workspace_id, created_at, channel, query, params, returned_ids) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        input.workspaceId,
        input.now,
        input.channel,
        input.query,
        JSON.stringify(input.params),
        JSON.stringify(input.returnedIds),
      ),
      // Standard SQLite (D1 included) has no DELETE ... LIMIT, so the bound is expressed
      // as a subquery: at most RECALL_LOG_PURGE_BATCH of the oldest rows past retention.
      env.DB.prepare(
        `DELETE FROM recall_log WHERE id IN (SELECT id FROM recall_log WHERE created_at < ? ORDER BY created_at ASC LIMIT ?)`,
      ).bind(cutoff, RECALL_LOG_PURGE_BATCH),
    ]);
  } catch (e) {
    console.error("recall_log write failed (non-fatal):", e);
  }
}

/**
 * Part B: a get, append, update or link on an id, within RECALL_LOG_FOLLOW_WINDOW_MS of a
 * recall that returned it, is implicit feedback that the recall was used. Looks up only
 * the LATEST recall_log row for the workspace (one indexed read on idx_recall_log_ws), and
 * writes only when that row both is recent enough and actually returned at least one of
 * `entryIds` — most calls cost the one read and nothing else. Feeds the golden set only
 * (D5.4); ranking never reads followed_ids.
 *
 * Takes every id from one caller (link's source and target) together rather than one call
 * per id: two independent read-then-write calls on the SAME row race — both can read the
 * row before either writes, and the second write then clobbers the first's mark.
 */
export async function maybeMarkFollowedMany(env: Env, cfg: Config, workspaceId: string, entryIds: readonly string[], now: number): Promise<void> {
  if (cfg.RECALL_LOG !== "on" || entryIds.length === 0) return;
  try {
    const row = await env.DB.prepare(
      `SELECT id, returned_ids, followed_ids FROM recall_log WHERE workspace_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(workspaceId, now - RECALL_LOG_FOLLOW_WINDOW_MS).first() as { id: string; returned_ids: string; followed_ids: string } | null;
    if (!row) return;

    let returned: unknown;
    let followed: unknown;
    try {
      returned = JSON.parse(row.returned_ids);
      followed = JSON.parse(row.followed_ids);
    } catch {
      return;
    }
    if (!Array.isArray(returned)) return;
    const followedList = Array.isArray(followed) ? followed as string[] : [];
    const newlyFollowed = entryIds.filter(id => returned.includes(id) && !followedList.includes(id));
    if (!newlyFollowed.length) return;

    await env.DB.prepare(`UPDATE recall_log SET followed_ids = ? WHERE id = ?`)
      .bind(JSON.stringify([...followedList, ...newlyFollowed]), row.id).run();
  } catch (e) {
    console.error("recall_log follow update failed (non-fatal):", e);
  }
}

export async function maybeMarkFollowed(env: Env, cfg: Config, workspaceId: string, entryId: string, now: number): Promise<void> {
  return maybeMarkFollowedMany(env, cfg, workspaceId, [entryId], now);
}
