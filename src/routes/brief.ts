import type { Env } from "../env";
import { json } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { scopeWhere, type ScopeClause } from "../lib/scope";
import { INDEXABLE_SQL } from "../capture/lifecycle";
import { isTopicTagSql } from "../compression/eligibility";
import { PENDING_INSIGHT_SQL } from "../memory/patterns";
import { STALE_REVIEW_SQL } from "../memory/stale";
import { OPEN_LOOP_SQL } from "../memory/loops";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { parseTags } from "../insight/candidates";
import {
  excludedIds, readResurfaceState, withDismissed, withShown, writeResurfaceState,
} from "../runtime/resurface-state";

/**
 * GET /brief — what the brain did while you were away.
 *
 * The dashboard used to open on an empty screen with a text box, on a brain
 * holding thousands of memories that four nightly jobs had spent the night
 * compressing, linking and judging. Everything below is already-produced work
 * being read back; nothing here computes, embeds, or calls a model.
 *
 * BUDGET. Six to eight D1 queries plus one KV read and at most one KV write,
 * no AI, no Vectorize, one HTTP round trip. Six queries run in parallel
 * (sources, patterns, activity, topics, the attention+loops aggregate, the
 * loops preview — Task A added the last of these, folding its count into the
 * aggregate for free and paying one query for its three preview rows). The
 * resurface pick runs AFTER that batch, as a separate 1-2 query step,
 * because Task B's topic preference needs the topics query's own result —
 * it cannot join the parallel batch it depends on. It costs one query when
 * there is no topic preference to test (a quiet week) or the pick is already
 * settled for today (KV's same-day fetch-by-id); two when a fresh pick has
 * topics to prefer (a count probe, then the pick itself). The KV read/write
 * are resurface v2's seen/dismissed state (src/runtime/resurface-state.ts) —
 * one read always, one write only when today's pick is new and this is not
 * a `?preview=1` request, so a preview deployment can be polled repeatedly
 * without disturbing production's rotation.
 *
 * Against this codebase's self-imposed ~50-call D1 budget per invocation
 * (the platform's real ceiling is 1,000), and against the free plan's 10 ms
 * CPU limit charged once per round trip: the alternative is the client
 * asking six-plus endpoints instead of one, which loses on both. Each query
 * is either indexed (created_at DESC) or bounded by a small LIMIT. The count
 * is pinned by test/integration/brief-budget.test.ts, and that pin is the
 * point: this endpoint is the one thing every user runs every time.
 */

/** Yesterday and today, so an early-morning open still has something to show. */
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Two weeks of activity: enough to show a rhythm, short enough to read. */
const ACTIVITY_DAYS = 14;

/** What the brain has been about lately, rather than all-time. */
const TOPIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Old enough that resurfacing it is a genuine reminder rather than an echo. */
const RESURFACE_MIN_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/** Below this, a memory is not worth interrupting someone with. */
const RESURFACE_MIN_IMPORTANCE = 3;

/**
 * Candidates worth resurfacing, written once so the row query and the count it
 * wraps against cannot drift apart — if they did, the offset would index into
 * a different set than the one being selected from.
 *
 * kind:episodic is excluded (v2): a live count against prod found the pool
 * dominated by episodic rows — the class that resurfaced a hotel stay two
 * months after the trip, a true-then, meaningless-now fact rather than a
 * genuine reminder. task:done is excluded because a finished commitment is
 * not a reminder either; it is history.
 */
const RESURFACE_FILTER = `created_at < ? AND importance_score >= ?
         AND tags NOT LIKE '%"status:deprecated"%'
         AND tags NOT LIKE '%"auto-pattern"%'
         AND tags NOT LIKE '%"auto-insight"%'
         AND tags NOT LIKE '%"synthesized"%'
         AND tags NOT LIKE '%"kind:episodic"%'
         AND tags NOT LIKE '%"task:done"%'`;

/** How far back "recently shown" reaches when excluding a repeat pick. */
const RESURFACE_RECENT_WINDOW_DAYS = 30;

/**
 * How many previously-shown/dismissed ids get bound into the resurface
 * exclusion clause. That clause is bound TWICE in the final pick query — once
 * in the row SELECT, once in the OFFSET subquery it wraps against — so at
 * this cap the query binds at most roughly 2 * (8 filter/topic placeholders +
 * 20 exclusion + 3 scope) + 1 day placeholder ≈ 63 parameters, well under
 * D1's 100-bound-parameter ceiling. `recent` can hold up to 30 ids in KV;
 * excludedIds() keeps the most recently shown of them first, so a truncation
 * here drops the oldest, least useful exclusions rather than the freshest.
 */
const RESURFACE_EXCLUDE_BOUND_CAP = 20;

export async function handleBriefRoutes(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response | null> {
  // POST /resurface/dismiss — "not this one". Scoped to the caller's own
  // resurface state (keyed on their personal workspace, see
  // src/runtime/resurface-state.ts), not to the entries table: dismissing an
  // id the caller cannot even see is harmless, it only ever excludes a future
  // pick, so this needs no entry lookup and costs no D1 call at all.
  if (url.pathname === "/resurface/dismiss" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);

    const workspaceKey = auth.personalWorkspaceId;
    const state = await readResurfaceState(env, workspaceKey);
    await writeResurfaceState(env, workspaceKey, withDismissed(state, body.id.trim()));

    return json({ ok: true });
  }

  if (url.pathname !== "/brief" || request.method !== "GET") return null;

  const auth = await requireIdentity(request, env);
  if (auth instanceof Response) return auth;
  // Every panel below reads only what this caller can see: their personal
  // workspace plus the company one. The clauses bind positionally, so each
  // query's bindings below carry them in statement order.
  const scope = scopeWhere(auth);
  const entryScope = scopeWhere(auth, undefined, "entries.workspace_id");

  // A preview deployment (see scripts/brief-preview.mjs) calls this
  // repeatedly against the live brain to check what would ship; it must
  // never leave a mark, so it skips only the resurface state's KV write
  // below. Everything else — including the KV read that drives same-day
  // stability — behaves identically.
  const preview = url.searchParams.get("preview") === "1";

  const now = Date.now();
  const since = now - RECENT_WINDOW_MS;
  const resurfaceBefore = now - RESURFACE_MIN_AGE_MS;
  const today = dayNumber(now);

  const [recentRows, patternRows, activityRows, topicRows, attentionRow, loopItemRows] = await Promise.all([
    // What arrived, and from where. Grouped rather than listed: the point is
    // "your brain grew, from these places", not another feed of rows.
    env.DB.prepare(
      `SELECT source, COUNT(*) AS n FROM entries
       WHERE created_at >= ? AND ${scope.clause} GROUP BY source ORDER BY n DESC`,
    ).bind(since, ...scope.bindings).all(),

    // Insights the weekly pass proposed and nobody has ruled on. These are
    // excluded from recall until confirmed, so leaving them unseen in a menu
    // is the same as throwing them away.
    env.DB.prepare(
      `SELECT id, content FROM entries
       WHERE ${PENDING_INSIGHT_SQL} AND ${scope.clause}
       ORDER BY created_at DESC LIMIT 3`,
    ).bind(...scope.bindings).all(),

    // Captures per day. Bucketed in SQL rather than by shipping timestamps and
    // grouping in the client, because the row count is the whole point and
    // there is no reason to send two weeks of rows to count them.
    env.DB.prepare(
      `SELECT CAST(created_at / 86400000 AS INTEGER) AS day, COUNT(*) AS n
       FROM entries WHERE created_at >= ? AND ${scope.clause}
       GROUP BY day ORDER BY day`,
    ).bind(now - ACTIVITY_DAYS * 86400000, ...scope.bindings).all(),

    // What the brain has been about this week, in the user's own vocabulary.
    // Same exclusions as /stats: the reserved namespaces are bookkeeping, and
    // hex-shaped tags are commit SHAs and colour codes a #token scan collected.
    // Scoped like every sibling query here. It was the one in this block that
    // was not, and the omission was visible on the front page: the topic chips
    // are rendered straight from this list, so a member's Home screen named
    // their colleagues' private tags back at them — "job-hunting" and
    // "confidential" alongside their own — while the counts beside them came
    // from correctly scoped queries and said something different.
    env.DB.prepare(
      `SELECT value AS tag, COUNT(*) AS n FROM entries, json_each(entries.tags)
       WHERE entries.created_at >= ?
         AND ${isTopicTagSql()}
         AND value NOT GLOB '[0-9]*'
         AND ${scope.clause}
       GROUP BY value ORDER BY n DESC LIMIT 6`,
    ).bind(now - TOPIC_WINDOW_MS, ...scope.bindings).all(),

    // The two things that make recall quietly worse, counted together so they
    // cost one query: memories recall cannot see, and memories the staleness
    // pass has flagged as possibly out of date.
    //
    // Deprecated entries are excluded from BOTH counts, for the same reason in
    // two forms. Their vectors were deleted on purpose — dismissing a pattern is
    // the common way — so counting them as "not searchable" reported the user's
    // own decision back to them as a problem, and grew the number every time they
    // dismissed one. A deprecated memory is likewise retired from recall, so
    // asking anyone to re-verify it is make-work.
    //
    // The stale count shares STALE_REVIEW_SQL with `GET /stale`, the queue this
    // chip opens. They are two readings of one fact: a chip that promises a
    // number the queue then fails to produce is the defect this replaced, and
    // one predicate is what stops it coming back.
    // open_loops rides this same aggregate — one more CASE/SUM on a query
    // already scanning every row, rather than a query of its own — the same
    // reasoning that put unindexed and stale here together.
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN vector_ids = '[]' AND ${INDEXABLE_SQL} THEN 1 ELSE 0 END) AS unindexed,
         SUM(CASE WHEN ${STALE_REVIEW_SQL} THEN 1 ELSE 0 END) AS stale,
         SUM(CASE WHEN ${OPEN_LOOP_SQL} THEN 1 ELSE 0 END) AS open_loops,
         COUNT(*) AS total
       FROM entries WHERE ${scope.clause}`,
    ).bind(...scope.bindings).first() as Promise<Record<string, any> | null>,

    // The loop queue's own preview: up to three most recent open commitments,
    // same row shape GET /loops returns, so the panel and the sheet behind it
    // read identically. One added query, the cost Task A's brief accepts for
    // showing anything beyond a bare count.
    env.DB.prepare(
      `SELECT id, content, source, tags, created_at FROM entries
       WHERE ${OPEN_LOOP_SQL} AND ${scope.clause}
       ORDER BY created_at DESC LIMIT 3`,
    ).bind(...scope.bindings).all(),
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

  // Days with no captures are absent from the GROUP BY and have to be filled
  // in, or the strip would silently compress a quiet week into a busy-looking
  // one — the shape of the rhythm is the information.
  const byDay = new Map<number, number>();
  for (const r of activityRows.results as { day: number; n: number }[]) byDay.set(r.day, r.n);
  const activity: { day: number; count: number }[] = [];
  for (let d = today - (ACTIVITY_DAYS - 1); d <= today; d++) {
    activity.push({ day: d, count: byDay.get(d) ?? 0 });
  }

  const topics = (topicRows.results as { tag: string; n: number }[]).map(r => ({ tag: r.tag, count: r.n }));

  // Resurface v2. Sequential rather than in the Promise.all above because the
  // topic-preference step needs `topics`, computed from that same batch — it
  // cannot join a race it depends on the result of.
  const workspaceKey = auth.personalWorkspaceId;
  const priorState = await readResurfaceState(env, workspaceKey);
  const excluded = excludedIds(priorState, today, RESURFACE_RECENT_WINDOW_DAYS)
    .slice(0, RESURFACE_EXCLUDE_BOUND_CAP);

  // "Not newly excluded" means not dismissed since being shown — checked
  // against `dismissed` alone, not the full `excluded` set: today's own pick
  // is trivially "recently shown" (it IS the most recent), so testing it
  // against `excluded` would always fail and this shortcut would never fire.
  let resurfaceRow = priorState.day === today && priorState.shownId && !priorState.dismissed.includes(priorState.shownId)
    // Same-day stability: fetch the exact row rather than re-selecting, so a
    // second app open the same day shows the same memory. Falls through to a
    // fresh pick below if the row is gone (deleted, or moved out of scope).
    ? await env.DB.prepare(
        `SELECT id, content, source, tags, created_at FROM entries WHERE id = ? AND ${scope.clause}`,
      ).bind(priorState.shownId, ...scope.bindings).first() as ResurfaceRow | null
    : null;

  let nextState = priorState;
  if (!resurfaceRow) {
    resurfaceRow = await pickResurface(env, scope, resurfaceBefore, topics, excluded, today) ?? null;
    if (resurfaceRow) nextState = withShown(priorState, resurfaceRow.id, today);
  }
  if (!preview && nextState !== priorState) {
    await writeResurfaceState(env, workspaceKey, nextState);
  }

  const loopItems = (loopItemRows.results as {
    id: string; content: string; source: string; tags: string; created_at: number;
  }[]).map(r => ({
    id: r.id,
    content: r.content,
    source: r.source,
    tags: parseTags(r.tags),
    created_at: r.created_at,
  }));

  return json({
    ok: true,
    window_hours: RECENT_WINDOW_MS / 3600000,
    captured,
    sources: bySource,
    patterns,
    resurface: resurfaceRow
      ? {
          id: resurfaceRow.id,
          content: resurfaceRow.content,
          source: resurfaceRow.source,
          // A malformed tags column (hand-edited, or a migration bug) must not
          // 500 the whole endpoint every day this row is picked, see
          // src/insight/candidates.ts's parseTags, the shared safe parser.
          tags: parseTags(resurfaceRow.tags),
          created_at: resurfaceRow.created_at,
        }
      : null,
    activity,
    topics,
    total: (attentionRow?.total as number) ?? 0,
    attention: {
      unindexed: (attentionRow?.unindexed as number) ?? 0,
      stale: (attentionRow?.stale as number) ?? 0,
      patterns: patterns.length,
    },
    loops: {
      open: (attentionRow?.open_loops as number) ?? 0,
      items: loopItems,
    },
  });
}

/** Days since the epoch: changes once a day, stable within it. */
function dayNumber(now: number): number {
  return Math.floor(now / 86400000);
}

interface ResurfaceRow {
  id: string; content: string; source: string; tags: string; created_at: number;
}

/**
 * Fresh resurface pick: prefer a candidate sharing one of this week's top
 * topic tags, falling back to the full candidate pool when that preferred
 * subset is empty (no topics this week, or none of the candidates carry one).
 *
 * Costs one D1 query when there is nothing to prefer (skips straight to the
 * fallback pool) or two when there is: a COUNT probe to test whether the
 * preferred subset has anything at all, then the pick itself against
 * whichever pool the probe selected. The pick query keeps the OFFSET-wraps-
 * inside-SQL trick from v1 (see the comment that used to sit on this query
 * inline, now here): the filter clause is bound twice, once for the row and
 * once for the count it wraps against, so a brain with fewer candidates than
 * the rotation constant never silently shows nothing.
 */
async function pickResurface(
  env: Env,
  scope: ScopeClause,
  resurfaceBefore: number,
  topics: { tag: string; count: number }[],
  excluded: string[],
  today: number,
): Promise<ResurfaceRow | undefined> {
  const exclusionClause = excluded.length ? `AND id NOT IN (${excluded.map(() => "?").join(", ")})` : "";
  const topicTags = topics.map(t => t.tag);

  let activeFilter = RESURFACE_FILTER;
  let extraFilterBindings: string[] = [];

  if (topicTags.length) {
    const topicClause = `(${topicTags.map(() => `tags LIKE ? ${TAG_LIKE_ESCAPE}`).join(" OR ")})`;
    const topicPatterns = topicTags.map(tagLikePattern);
    const preferredCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM entries
       WHERE (${RESURFACE_FILTER}) AND ${topicClause} ${exclusionClause} AND ${scope.clause}`,
    ).bind(resurfaceBefore, RESURFACE_MIN_IMPORTANCE, ...topicPatterns, ...excluded, ...scope.bindings)
      .first() as Record<string, any> | null;
    if (((preferredCount?.n as number) ?? 0) > 0) {
      activeFilter = `(${RESURFACE_FILTER}) AND ${topicClause}`;
      extraFilterBindings = topicPatterns;
    }
  }

  const filterBindings = [resurfaceBefore, RESURFACE_MIN_IMPORTANCE, ...extraFilterBindings];
  const { results } = await env.DB.prepare(
    `SELECT id, content, source, tags, created_at FROM entries
     WHERE (${activeFilter}) ${exclusionClause} AND ${scope.clause}
     ORDER BY id
     LIMIT 1
     OFFSET (? % MAX((SELECT COUNT(*) FROM entries WHERE (${activeFilter}) ${exclusionClause} AND ${scope.clause}), 1))`,
  ).bind(
    ...filterBindings, ...excluded, ...scope.bindings,
    today,
    ...filterBindings, ...excluded, ...scope.bindings,
  ).all();

  return (results as unknown as ResurfaceRow[])[0];
}
