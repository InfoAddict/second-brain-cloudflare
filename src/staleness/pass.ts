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

// `known` lets the caller spend the row it already selected on the first attempt instead
// of re-reading it; a lost CAS drops back to a fresh read for the retry.
//
// The guard covers content as well as tags because the classification is derived from
// content. Guarding tags alone is not enough: for an entry carrying neither a volatility:
// nor a stale:as-of tag — the common case — the mutation is a no-op on tags, so a
// concurrent rewrite would leave the guard satisfied and the CAS would commit a verdict
// about content that no longer exists. That misfire does not self-correct either, since
// the concurrent write also bumps updated_at past the staleness cutoff.
async function casUpdateEntry(
  env: Env,
  id: string,
  mutate: (row: { tags: string[]; content: string }) => { tags: string[] },
  extraSets: Record<string, unknown> = {},
  known?: { tags: string; content: string },
): Promise<boolean> {
  let current = known;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (current === undefined) {
      const row = await env.DB.prepare(`SELECT tags, content FROM entries WHERE id = ?`).bind(id).first() as { tags: string; content: string } | null;
      if (!row) return false;
      current = { tags: row.tags ?? "[]", content: row.content };
    }
    const next = mutate({ tags: JSON.parse(current.tags), content: current.content });
    const nextTagsJson = JSON.stringify(next.tags);
    const setClauses = ["tags = ?"];
    const bindings: unknown[] = [nextTagsJson];
    for (const [col, val] of Object.entries(extraSets)) {
      setClauses.push(`${col} = ?`);
      bindings.push(val);
    }
    bindings.push(id, current.tags, current.content);
    const result = await env.DB.prepare(
      `UPDATE entries SET ${setClauses.join(", ")} WHERE id = ? AND tags = ? AND content = ?`,
    ).bind(...bindings).run();
    if ((result.meta.changes ?? 0) > 0) return true;
    current = undefined; // CAS lost (or the row is gone) — retry against a fresh read
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

      const settled = await casUpdateEntry(env, row.id, ({ tags, content }) => {
        const classified = classifyVolatility(content, tags);
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
      }, { staleness_checked_at: now }, { tags: row.tags ?? "[]", content: row.content });

      if (!settled) {
        // Every CAS attempt lost, or the row is gone. Advance the cursor anyway: the
        // candidate query orders by COALESCE(staleness_checked_at, 0) ASC, so leaving it
        // NULL would put this row first on every future pass, camping one of the 25 slots
        // indefinitely. The next pass will pick it up again on its merits.
        await env.DB.prepare(`UPDATE entries SET staleness_checked_at = ? WHERE id = ?`).bind(now, row.id).run();
      }
    } catch (e) {
      console.error(`Staleness pass failed for ${row.id} (non-fatal):`, e);
    }
  }
}
