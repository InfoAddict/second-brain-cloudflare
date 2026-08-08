import type { Env } from "../env";
import { json, requireAuth } from "../lib/http";

/**
 * GET /brief — what the brain did while you were away.
 *
 * The dashboard used to open on an empty screen with a text box, on a brain
 * holding thousands of memories that four nightly jobs had spent the night
 * compressing, linking and judging. Everything below is already-produced work
 * being read back; nothing here computes, embeds, or calls a model.
 *
 * BUDGET. Four D1 queries, no AI, no Vectorize, and one HTTP round trip
 * because the alternative — the client asking four endpoints — spends four of
 * the ~50 subrequests a free-plan invocation gets, on every app open. Each
 * query is either indexed (created_at DESC) or bounded by a small LIMIT. The
 * count is pinned by test/integration/brief-budget.test.ts.
 */

/** Yesterday and today, so an early-morning open still has something to show. */
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Old enough that resurfacing it is a genuine reminder rather than an echo. */
const RESURFACE_MIN_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/** Below this, a memory is not worth interrupting someone with. */
const RESURFACE_MIN_IMPORTANCE = 3;

/**
 * Candidates worth resurfacing, written once so the row query and the count it
 * wraps against cannot drift apart — if they did, the offset would index into
 * a different set than the one being selected from.
 */
const RESURFACE_FILTER = `created_at < ? AND importance_score >= ?
         AND tags NOT LIKE '%"status:deprecated"%'
         AND tags NOT LIKE '%"auto-pattern"%'
         AND tags NOT LIKE '%"synthesized"%'`;

export async function handleBriefRoutes(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response | null> {
  if (url.pathname !== "/brief" || request.method !== "GET") return null;

  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const now = Date.now();
  const since = now - RECENT_WINDOW_MS;
  const resurfaceBefore = now - RESURFACE_MIN_AGE_MS;

  const [recentRows, patternRows, resurfaceRows] = await Promise.all([
    // What arrived, and from where. Grouped rather than listed: the point is
    // "your brain grew, from these places", not another feed of rows.
    env.DB.prepare(
      `SELECT source, COUNT(*) AS n FROM entries
       WHERE created_at >= ? GROUP BY source ORDER BY n DESC`,
    ).bind(since).all(),

    // Patterns the nightly pass proposed and nobody has ruled on. These are
    // excluded from recall until confirmed, so leaving them unseen in a menu
    // is the same as throwing them away.
    env.DB.prepare(
      `SELECT id, content FROM entries
       WHERE tags LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"status:deprecated"%'
       ORDER BY created_at DESC LIMIT 3`,
    ).all(),

    // One old, important memory. There is no last-recalled column and adding
    // one is not worth a migration for this, so the pick is deterministic per
    // day: the same memory all day, a different one tomorrow. Ordering by id
    // keeps it stable regardless of what else is written today.
    //
    // The offset wraps inside SQL against a count of the same candidate set.
    // Taking the day number modulo a constant instead looks equivalent and is
    // not: OFFSET past the end returns no rows, so any brain with fewer
    // candidates than the constant would silently show nothing on most days.
    // MAX(…, 1) keeps the modulo defined when there are no candidates at all.
    // Positional placeholders, so the filter is bound twice — once for the row
    // and once for the count it wraps against. Numbered (?1) parameters would
    // say it once but are not what the rest of this codebase or its SQLite
    // test double use.
    env.DB.prepare(
      `SELECT id, content, created_at FROM entries
       WHERE ${RESURFACE_FILTER}
       ORDER BY id
       LIMIT 1
       OFFSET (? % MAX((SELECT COUNT(*) FROM entries WHERE ${RESURFACE_FILTER}), 1))`,
    ).bind(
      resurfaceBefore, RESURFACE_MIN_IMPORTANCE,
      dayNumber(now),
      resurfaceBefore, RESURFACE_MIN_IMPORTANCE,
    ).all(),
  ]);

  const bySource = (recentRows.results as { source: string | null; n: number }[]).map(r => ({
    source: r.source ?? "unknown",
    count: r.n,
  }));
  const captured = bySource.reduce((sum, r) => sum + r.count, 0);

  const patterns = (patternRows.results as { id: string; content: string }[]).map(r => ({
    id: r.id,
    content: r.content,
  }));

  const resurfaceRow = (resurfaceRows.results as { id: string; content: string; created_at: number }[])[0];

  return json({
    ok: true,
    window_hours: RECENT_WINDOW_MS / 3600000,
    captured,
    sources: bySource,
    patterns,
    resurface: resurfaceRow
      ? { id: resurfaceRow.id, content: resurfaceRow.content, created_at: resurfaceRow.created_at }
      : null,
  });
}

/** Days since the epoch: changes once a day, stable within it. */
function dayNumber(now: number): number {
  return Math.floor(now / 86400000);
}
