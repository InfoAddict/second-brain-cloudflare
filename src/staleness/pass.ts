import type { Env } from "../env";
import { initializeDatabase } from "../db/init";
import { getStatus } from "../memory/status";
import { getVolatility, withVolatility } from "../memory/volatility";
import { hasStaleAsOf, withStaleAsOf, withoutStaleAsOf } from "../memory/stale";
import { classifyVolatility, shouldFlagStale } from "./heuristic";

export const STALENESS_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const STALENESS_PASS_LIMIT = 25;

const SYSTEM_TAG_EXCLUSIONS = [
  `tags NOT LIKE '%"status:deprecated"%'`,
  `tags NOT LIKE '%"auto-pattern"%'`,
  `tags NOT LIKE '%"synthesized"%'`,
  `tags NOT LIKE '%"rolled-up"%'`,
].join(" AND ");

async function casUpdateEntry(
  env: Env,
  id: string,
  mutate: (row: { tags: string[] }) => { tags: string[] },
  extraSets: Record<string, unknown> = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await env.DB.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(id).first() as { tags: string } | null;
    if (!row) return false;
    const currentTagsJson = row.tags ?? "[]";
    const next = mutate({ tags: JSON.parse(currentTagsJson) });
    const nextTagsJson = JSON.stringify(next.tags);
    const setClauses = ["tags = ?"];
    const bindings: unknown[] = [nextTagsJson];
    for (const [col, val] of Object.entries(extraSets)) {
      setClauses.push(`${col} = ?`);
      bindings.push(val);
    }
    bindings.push(id, currentTagsJson);
    const result = await env.DB.prepare(
      `UPDATE entries SET ${setClauses.join(", ")} WHERE id = ? AND tags = ?`,
    ).bind(...bindings).run();
    if ((result.meta.changes ?? 0) > 0) return true;
  }
  return false;
}

export async function runStalenessPass(env: Env, _ctx: ExecutionContext): Promise<void> {
  await initializeDatabase(env);

  const cutoff = Date.now() - STALENESS_AGE_MS;
  const now = Date.now();
  let candidates: { id: string; content: string; tags: string }[] = [];

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags FROM entries
       WHERE COALESCE(updated_at, created_at) < ?
         AND ${SYSTEM_TAG_EXCLUSIONS}
       ORDER BY COALESCE(staleness_checked_at, 0) ASC
       LIMIT ${STALENESS_PASS_LIMIT}`,
    ).bind(cutoff).all() as { results: { id: string; content: string; tags: string }[] };
    candidates = results;
  } catch (e) {
    console.error("Staleness pass query failed (non-fatal):", e);
    return;
  }

  for (const row of candidates) {
    try {
      if (getStatus(JSON.parse(row.tags ?? "[]")) === "deprecated") {
        await env.DB.prepare(`UPDATE entries SET staleness_checked_at = ? WHERE id = ?`).bind(now, row.id).run();
        continue;
      }

      await casUpdateEntry(env, row.id, ({ tags }) => {
        const classified = classifyVolatility(row.content, tags);
        const existing = getVolatility(tags);

        if (classified && !existing) {
          tags = withVolatility(tags, classified);
        }

        const volatility = getVolatility(tags);

        if (shouldFlagStale(volatility)) {
          if (!hasStaleAsOf(tags)) tags = withStaleAsOf(tags);
        } else if (volatility === "durable") {
          tags = withoutStaleAsOf(tags);
        }

        return { tags };
      }, { staleness_checked_at: now });
    } catch (e) {
      console.error(`Staleness pass failed for ${row.id} (non-fatal):`, e);
    }
  }
}
