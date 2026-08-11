import type { Env } from "../env";
import { resolveConfig } from "../config";
import { SB_VERSION } from "../env";
import { COMPRESSION_MIN_AGE_MS, compressionEligibilitySql, isTopicTagSql } from "../compression/eligibility";
import { intParam, json, requireAuth } from "../lib/http";
import { graceMs } from "../lib/ai";
import { classifyEntry } from "../capture/classify";
import { storeEntry } from "../capture/store";
import { INDEXABLE_SQL } from "../capture/lifecycle";
import { PENDING_INSIGHT_SQL } from "../memory/patterns";
import { getStatus, withStatus } from "../memory/status";
import { withKind } from "../memory/kind";
import { checkVectorizeHealth } from "../vectorize/health";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { reasonOverPair } from "../insight/reason";
import { MAX_INSIGHTS_PER_RUN } from "../insight/weekly";

/**
 * Ids accepted by one bulk resolve. D1 allows 100 bound parameters per
 * statement and the id list is the whole of the SELECT's binding, so this is
 * the hard limit rather than a policy. The client pages against it.
 */
const MAX_PATTERN_BULK = 100;

export async function handleAdminRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  const cfg = await resolveConfig(env);
  // GET /stats
  if (url.pathname === "/stats" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const graceCutoff = Date.now() - graceMs(env);
    const [summary, tagRows, candidateRows] = await Promise.all([
      env.DB.prepare(
        // unvectorized skips deprecated entries: their vectors were deleted
        // deliberately, so counting them here offered the user a repair for
        // something that is not broken.
        `SELECT COUNT(*) as count, AVG(importance_score) as avg_importance,
         SUM(CASE WHEN vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL} THEN 1 ELSE 0 END) as unvectorized,
         SUM(CASE WHEN tags NOT LIKE '%"status:%' AND tags NOT LIKE '%"kind:%' THEN 1 ELSE 0 END) as unclassified
         FROM entries`
      ).bind(graceCutoff).first() as Promise<Record<string, any> | null>,
      // Reserved namespaces and pipeline markers are excluded here rather than
      // hidden in the client: this panel answers "what is my brain about?", and
      // kind:episodic outranked every real topic on a production brain. Numeric
      // tags are legacy issue references (see src/text/hashtags.ts). LIMIT is
      // raised because the filter now discards rows the ORDER BY ranked first.
      env.DB.prepare(
        `SELECT value, COUNT(*) as n FROM entries, json_each(entries.tags)
         WHERE value NOT LIKE 'kind:%' AND value NOT LIKE 'status:%'
           AND value NOT LIKE 'volatility:%' AND value NOT LIKE 'stale:%'
           AND value NOT IN ('auto-pattern', 'auto-insight', 'synthesized', 'rolled-up', 'duplicate-candidate')
           AND value NOT GLOB '[0-9]*'
         GROUP BY value ORDER BY n DESC LIMIT 5`,
      ).all(),
      env.DB.prepare(`
        SELECT value as tag, COUNT(*) as count
        FROM entries, json_each(entries.tags)
        WHERE ${isTopicTagSql()}
          AND entries.tags NOT LIKE '%"rolled-up"%'
          AND entries.tags NOT LIKE '%"synthesized"%'
          AND entries.tags NOT LIKE '%"auto-pattern"%'
          AND entries.tags NOT LIKE '%"auto-insight"%'
          AND ${compressionEligibilitySql("entries.", cfg)}
        GROUP BY value
        HAVING count > 10
        ORDER BY count DESC
        LIMIT 10
      `).bind(Date.now() - cfg.COMPRESSION_MIN_AGE_MS).all(),
    ]);

    const cutoff = Date.now() - 86400000;
    const digestCandidates: { tag: string; count: number }[] = [];
    for (const row of candidateRows.results as any[]) {
      const existing = await env.DB.prepare(
        `SELECT id FROM entries WHERE tags LIKE '%"synthesized"%' AND tags LIKE ? ${TAG_LIKE_ESCAPE} AND created_at > ? LIMIT 1`
      ).bind(tagLikePattern(row.tag as string), cutoff).first();
      if (!existing) digestCandidates.push({ tag: row.tag as string, count: row.count as number });
    }

    return json({
      count: (summary?.count as number) ?? 0,
      avg_importance: summary?.avg_importance != null ? Math.round((summary.avg_importance as number) * 10) / 10 : null,
      top_tags: (tagRows.results as any[]).map(r => r.value as string),
      digest_candidates: digestCandidates,
      unvectorized: (summary?.unvectorized as number) ?? 0,
      vectorize_grace_ms: graceMs(env),
      unclassified: (summary?.unclassified as number) ?? 0,
    });
  }

  // GET /health — index/runtime health, used by the dashboard banner, the
  // README verify step, and external uptime checks.
  if (url.pathname === "/health" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const vectorize = await checkVectorizeHealth(env);
    return json({ ok: vectorize.ok, version: SB_VERSION, vectorize });
  }

  // GET /patterns — the whole review queue, paged.
  //
  // The dashboard used to build this list from `/list?n=20&tag=auto-pattern`
  // (the old producer) and drop the deprecated rows in the browser, which
  // cannot work on a brain that has been running a while: dismissed insight
  // proposals keep their tag forever, so once there are more than a page of
  // them the filter throws away every row and the panel renders empty while
  // real proposals wait behind them. Filtering belongs in the query.
  if (url.pathname === "/patterns" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const limit = intParam(url, "limit", { fallback: 50, min: 1, max: 100 });
    if (limit instanceof Response) return limit;
    const offset = intParam(url, "offset", { fallback: 0, min: 0 });
    if (offset instanceof Response) return offset;

    const [rows, countRow] = await Promise.all([
      env.DB.prepare(
        `SELECT id, content, created_at FROM entries
         WHERE ${PENDING_INSIGHT_SQL}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).bind(limit, offset).all(),
      // The total drives "N waiting" and the pager. It is a second query rather
      // than a window function so the shape survives D1's SQLite build.
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE ${PENDING_INSIGHT_SQL}`,
      ).first() as Promise<Record<string, any> | null>,
    ]);

    return json({
      ok: true,
      patterns: (rows.results as Record<string, any>[]).map(r => ({
        id: r.id as string,
        content: r.content as string,
        created_at: r.created_at as number,
      })),
      total: (countRow?.n as number) ?? 0,
      limit,
      offset,
    });
  }

  // POST /patterns/resolve — confirm or dismiss a proposed insight.
  // Dashboard-only, no MCP twin: insight review is a human curation act, not
  // an agent capability. Confirm promotes an insight into a real recallable
  // memory; dismiss deprecates it (audit row kept, vectors removed).
  //
  // Takes `id` for one or `ids` for many. Ruling on a backlog one at a time is
  // the actual complaint this answers, and doing it as N single requests would
  // be N round trips against a Worker that gets ~50 D1 queries per invocation.
  if (url.pathname === "/patterns/resolve" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let body: { id?: string; ids?: unknown; action?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

    const action = body.action;
    if (action !== "confirm" && action !== "dismiss") {
      return json({ ok: false, error: `action must be "confirm" or "dismiss"` }, 400);
    }

    const single = body.id?.trim();
    let ids: string[];
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.some(i => typeof i !== "string")) {
        return json({ ok: false, error: "ids must be an array of strings" }, 400);
      }
      // De-duplicated because the same id twice would bind two parameters and
      // count the same row twice in the reply.
      ids = [...new Set((body.ids as string[]).map(i => i.trim()).filter(Boolean))];
      if (!ids.length) return json({ ok: false, error: "ids must not be empty" }, 400);
      // D1 allows 100 bound parameters per statement, and the id list is the
      // whole of the SELECT's binding. The client pages; this refuses rather
      // than silently truncating, because a silent truncation here reads as
      // "those patterns were resolved" when they were not.
      if (ids.length > MAX_PATTERN_BULK) {
        return json({ ok: false, error: `ids must not exceed ${MAX_PATTERN_BULK} per request` }, 400);
      }
    } else {
      if (!single) return json({ ok: false, error: "id is required" }, 400);
      ids = [single];
    }

    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, tags, vector_ids FROM entries WHERE id IN (${placeholders})`,
    ).bind(...ids).all();
    const found = results as Record<string, any>[];

    // The single-id form keeps its precise errors, because a client asking about
    // one pattern can act on "not found" and the bulk form cannot.
    if (body.ids === undefined) {
      if (!found.length) return json({ ok: false, error: `No entry found with ID: ${ids[0]}` }, 404);
      if (!(JSON.parse(found[0].tags ?? "[]") as string[]).includes("auto-insight")) {
        return json({ ok: false, error: "Entry is not a derived insight" }, 400);
      }
    }

    const statements: D1PreparedStatement[] = [];
    const vectorsToDrop: string[] = [];
    const resolved: string[] = [];

    for (const row of found) {
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      // Anything that is not an unresolved pattern is skipped rather than
      // rejected: a bulk request built from a list the user was looking at can
      // legitimately race a nightly pass or a second tab.
      if (!tags.includes("auto-insight") || getStatus(tags) === "deprecated") continue;

      if (action === "confirm") {
        // Losing the auto-insight tag is what exits the recall exclusion — it is
        // enforced at D1 hydration, not vector metadata, so this tag update alone
        // makes the entry recallable. No re-embed: content is unchanged and vectors
        // already exist (the stale auto-insight flag in vector metadata is harmless).
        const promoted = withStatus(withKind(tags.filter(t => t !== "auto-insight"), "semantic"), "canonical");
        statements.push(
          env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(promoted), row.id),
        );
      } else {
        // Inlined rather than calling deprecateEntry per id: that reads the row
        // again and issues its own UPDATE and its own Vectorize delete, so a
        // hundred dismissals would be three hundred subrequests. Same effect —
        // status:deprecated, vectors emptied, vectors deleted — in a fixed three.
        statements.push(
          env.DB.prepare(`UPDATE entries SET tags = ?, vector_ids = ? WHERE id = ?`)
            .bind(JSON.stringify(withStatus(tags, "deprecated")), "[]", row.id),
        );
        vectorsToDrop.push(...(JSON.parse(row.vector_ids ?? "[]") as string[]));
      }
      resolved.push(row.id as string);
    }

    // One subrequest however many statements it holds, which is the whole reason
    // the loop above builds them instead of running them.
    if (statements.length) await env.DB.batch(statements);

    if (vectorsToDrop.length) {
      try {
        await env.VECTORIZE.deleteByIds(vectorsToDrop);
      } catch (e) {
        // D1 already says deprecated and recall filters on that, so the entries
        // are out of recall either way; the index just keeps some dead vectors.
        console.error("Vectorize deleteByIds failed during bulk dismiss (non-fatal):", e);
      }
    }

    return json({
      ok: true,
      action,
      resolved: resolved.length,
      // Named, so a client that showed the user N rows can tell which survived a
      // race rather than assuming all of them were ruled on.
      ids: resolved,
      skipped: ids.length - resolved.length,
      ...(body.ids === undefined ? { id: ids[0] } : {}),
    });
  }

  // POST /vectorize-pending
  if (url.pathname === "/vectorize-pending" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const graceCutoff = Date.now() - graceMs(env);

    // Deprecated entries are skipped, matching the migration path
    // (src/migration/embedding.ts). Without this, dismissing a pattern deleted
    // its vectors and then this button put them straight back — spending the
    // daily embedding budget to reindex something the user had just told the
    // brain to drop, and crowding the vector query with candidates that recall
    // discards at hydration anyway.
    const { results: toProcess } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at FROM entries
       WHERE vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL}
       ORDER BY created_at DESC LIMIT 25`
    ).bind(graceCutoff).all();

    let processed = 0;
    let failed = 0;

    for (const row of toProcess as Record<string, any>[]) {
      try {
        await storeEntry(
          env,
          row.id as string,
          row.content as string,
          JSON.parse(row.tags as string),
          row.source as string,
          row.created_at as number,
          // Without this the backfill embeds with DEFAULTS.EMBEDDING_MODEL while
          // capture and recall use the configured one, writing vectors from the
          // wrong model into the index — scores go quietly wrong, nothing throws.
          cfg
        );
        processed++;
      } catch (e) {
        console.error("Re-embed failed for entry", row.id, e);
        failed++;
      }
    }

    // Same filter as the select above, or the loop never reaches zero: the
    // dashboard presses this until `remaining` is 0, so counting rows the select
    // refuses to process would spin until the batch-made-no-progress guard.
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM entries WHERE vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL}`
    ).bind(graceCutoff).first() as Record<string, any> | null;

    return json({ processed, failed, remaining: (remaining?.count as number) ?? 0 });
  }

  // POST /classify-pending
  // One-time, opt-in backfill: runs classifyEntry over entries that predate the
  // status (#119) and kind (#12) features and writes status:/kind: tags. Bounded
  // batch per call, idempotent (skips entries that already carry either tag), and
  // resumable (safe to stop/restart). No schema migration — only writes tags.
  if (url.pathname === "/classify-pending" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const UNCLASSIFIED_WHERE = `tags NOT LIKE '%"status:%' AND tags NOT LIKE '%"kind:%'`;

    const { results: toProcess } = await env.DB.prepare(
      `SELECT id, content, tags FROM entries
       WHERE ${UNCLASSIFIED_WHERE}
       ORDER BY created_at ASC LIMIT 25`
    ).all();

    let processed = 0;
    let failed = 0;

    for (const row of toProcess as Record<string, any>[]) {
      try {
        // cfg carries the user's LLM_MODEL choice; without it this backfill
        // classifies with the shipped default and ignores their setting.
        const { canonical, kind } = await classifyEntry(row.content as string, env, cfg);
        let tags: string[] = JSON.parse(row.tags as string);
        if (kind) tags = withKind(tags, kind);
        if (canonical && getStatus(tags) === null) tags = withStatus(tags, "canonical");
        await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(tags), row.id).run();
        processed++;
      } catch (e) {
        console.error("Classification backfill failed for entry", row.id, e);
        failed++;
      }
    }

    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM entries WHERE ${UNCLASSIFIED_WHERE}`
    ).first() as Record<string, any> | null;

    return json({ processed, failed, remaining: (remaining?.count as number) ?? 0 });
  }

  // GET /insights/dry-run — what the weekly pass would say, without saying it.
  //
  // Ships ahead of the weekly writer being enabled. The design was validated
  // against a brain that is not representative, so the first question is
  // whether the shortlist is any good on real data — and this answers it for
  // the price of a few model calls and no writes at all. A declined candidate
  // is reported with null shape/text rather than dropped, so a reader can see
  // a high-scoring pair was considered and rejected, not just what survived.
  if (url.pathname === "/insights/dry-run" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const limit = intParam(url, "limit", { fallback: 10, min: 1, max: 25 });
    if (limit instanceof Response) return limit;

    const { results } = await env.DB.prepare(
      `SELECT c.id, c.a_id, c.b_id, c.score, a.content AS a_content, b.content AS b_content
       FROM insight_candidates c
       JOIN entries a ON a.id = c.a_id
       JOIN entries b ON b.id = c.b_id
       WHERE c.status = 'pending'
       ORDER BY c.score DESC
       LIMIT ?`,
    ).bind(limit).all() as { results: Record<string, any>[] };

    const candidates = [];
    // Reasons over every row the query returned, deliberately past the three
    // production would ever write (src/insight/weekly.ts's own
    // MAX_INSIGHTS_PER_RUN cap) — seeing candidates four and beyond is how the
    // ranking itself gets judged. `would_write` is what keeps that honest: it
    // marks only the first three ACCEPTED candidates in score order, because
    // that's what the real pass's `written` counter tracks — a decline costs a
    // model call but never consumes a cap slot, so it must not shift who
    // counts as the fourth accepted candidate.
    let written = 0;
    for (const row of results) {
      // cfg carries the user's LLM_MODEL choice, same as the real weekly pass
      // (src/insight/weekly.ts) — without it this would preview reasoning from
      // the shipped default model rather than the one that will actually run.
      const insight = await reasonOverPair(
        { content: row.a_content as string },
        { content: row.b_content as string },
        env,
        cfg,
      );
      const would_write = insight !== null && written < MAX_INSIGHTS_PER_RUN;
      if (insight) written++;
      candidates.push({
        a_id: row.a_id as string,
        b_id: row.b_id as string,
        score: row.score as number,
        shape: insight?.shape ?? null,
        text: insight?.text ?? null,
        would_write,
      });
    }

    return json({ ok: true, candidates });
  }

  return null;
}
