/**
 * Nightly candidate accrual.
 *
 * Search and reasoning are split because coverage, not token cost, is what
 * binds. A weekly job gets ~50 D1 subrequests, which buys about 25 Vectorize
 * seeds — 97 weeks to cross a 1,940-entry brain once. Accruing nightly from the
 * entries just written turns that into continuous coverage, and new entries are
 * where new tension appears: a memory written today is the one most likely to
 * contradict or extend something from March.
 *
 * Nothing here re-embeds. Vectors were written at capture time; this reads them.
 */
import type { Env } from "../env";
import { initializeDatabase } from "../db/init";
import { VECTORIZE_GET_BY_IDS_BATCH } from "../constants";
import { isInsightEligible } from "./eligibility";
import { MIN_GAP_MS, MIN_SIMILARITY, normalisePair, scoreCandidate, type ScorableEntry } from "./score";

/** Where accrual resumes from. Operational state, so KV rather than a column. */
export const ACCRUAL_CURSOR_KEY = "insight:accrual-cursor";

/**
 * Seeds per run. Each costs one Vectorize query, and the budget is 50
 * subrequests for the whole invocation: one KV read, one D1 select, two
 * getByIds batches, 25 queries, one batched insert, one KV write is ~31.
 */
export const ACCRUAL_SEED_LIMIT = 25;

/** Neighbours considered per seed. */
const NEIGHBOUR_TOP_K = 10;

interface SeedRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
  importance_score: number | null;
  vector_ids: string;
}

const parseTags = (raw: string): string[] => {
  try { return JSON.parse(raw ?? "[]"); } catch { return []; }
};

export async function runInsightAccrual(env: Env, ctx: ExecutionContext): Promise<void> {
  try {
    await initializeDatabase(env);

    let cursor = 0;
    try {
      const raw = await env.OAUTH_KV.get(ACCRUAL_CURSOR_KEY);
      cursor = raw ? parseInt(raw, 10) || 0 : 0;
    } catch (e) {
      console.error("Insight accrual cursor read failed; starting from the top (non-fatal):", e);
    }

    // Entries written since the last run, oldest first so the cursor advances
    // monotonically. When there are none the same query walks forward from the
    // cursor anyway, which is the backfill: on a quiet night it picks up
    // historical entries instead of doing nothing.
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at, importance_score, vector_ids
       FROM entries
       WHERE created_at > ?
       ORDER BY created_at ASC
       LIMIT ${ACCRUAL_SEED_LIMIT}`,
    ).bind(cursor).all() as { results: SeedRow[] };

    const seeds = results.filter(r =>
      isInsightEligible({ content: r.content, tags: parseTags(r.tags), source: r.source })
      && parseTags(r.vector_ids).length > 0
    );
    if (!seeds.length) return;

    const vectorById = new Map<string, number[]>();
    const headIdOf = new Map<string, string>();
    for (const seed of seeds) {
      const head = parseTags(seed.vector_ids)[0];
      if (head) headIdOf.set(seed.id, head);
    }

    const headIds = [...headIdOf.values()];
    for (let i = 0; i < headIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
      const batch = headIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH);
      const fetched = await env.VECTORIZE.getByIds(batch);
      for (const v of fetched as { id: string; values?: number[] }[]) {
        if (v.values) vectorById.set(v.id, v.values);
      }
    }

    // Nothing came back. That is not an error — an index still catching up
    // returns an empty array rather than throwing — but advancing the cursor
    // past seeds that were never examined would skip them permanently, which
    // is precisely what the cursor exists to prevent. Leave it and retry.
    if (!vectorById.size) return;

    const rows: {
      id: string; a: string; b: string; similarity: number; gap: number; score: number;
    }[] = [];

    for (const seed of seeds) {
      const head = headIdOf.get(seed.id);
      const values = head ? vectorById.get(head) : undefined;
      if (!values) continue;

      const { matches } = await env.VECTORIZE.query(values, {
        topK: NEIGHBOUR_TOP_K,
        returnMetadata: "all",
      });

      const seedScorable: ScorableEntry = {
        id: seed.id,
        tags: parseTags(seed.tags),
        importance: seed.importance_score ?? 0,
        createdAt: seed.created_at,
      };

      for (const match of matches) {
        const meta = (match.metadata ?? {}) as Record<string, any>;
        const parentId = (meta.parentId ?? match.id) as string;
        // Another chunk of the same entry is not a second memory.
        if (parentId === seed.id) continue;
        if (match.score < MIN_SIMILARITY) continue;

        const createdAt = Number(meta.created_at ?? 0);
        const gap = Math.abs(seed.created_at - createdAt);
        if (gap < MIN_GAP_MS) continue;

        const tags: string[] = Array.isArray(meta.tags) ? meta.tags : [];
        const eligible = isInsightEligible({
          content: String(meta.content ?? ""),
          tags,
          source: String(meta.source ?? ""),
        });
        if (!eligible) continue;

        const other: ScorableEntry = { id: parentId, tags, importance: 0, createdAt };
        const [a, b] = normalisePair(seed.id, parentId);
        rows.push({
          id: crypto.randomUUID(),
          a, b,
          similarity: match.score,
          gap,
          score: scoreCandidate(seedScorable, other, match.score),
        });
      }
    }

    if (rows.length) {
      const now = Date.now();
      // One batch is one subrequest whatever it carries — the same argument
      // src/compression/digest.ts makes for its rolled-up marks.
      await env.DB.batch(rows.map(r => env.DB.prepare(
        `INSERT INTO insight_candidates
           (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'vector', 'pending', ?)
         ON CONFLICT(a_id, b_id) DO NOTHING`,
      ).bind(r.id, r.a, r.b, r.similarity, r.gap, r.score, now)));
    }

    // Explicitly recorded supersessions. One query, and the pairs it yields are
    // the highest-precision input available — but only about half of the
    // system-provenance edges are genuine, so these are proposals for the
    // reasoning step to accept or decline, never claims.
    try {
      const { results: superseded } = await env.DB.prepare(
        `SELECT e.source_id, e.target_id,
                a.created_at AS a_created, b.created_at AS b_created
         FROM edges e
         JOIN entries a ON a.id = e.source_id
         JOIN entries b ON b.id = e.target_id
         WHERE e.type = 'supersedes'
           AND ABS(a.created_at - b.created_at) >= ?
         ORDER BY e.created_at DESC
         LIMIT 10`,
      ).bind(MIN_GAP_MS).all() as {
        results: { source_id: string; target_id: string; a_created: number; b_created: number }[];
      };

      if (superseded.length) {
        const now = Date.now();
        await env.DB.batch(superseded.map(row => {
          const [a, b] = normalisePair(row.source_id, row.target_id);
          const gap = Math.abs(row.a_created - row.b_created);
          return env.DB.prepare(
            `INSERT INTO insight_candidates
               (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
             VALUES (?, ?, ?, 1.0, ?, ?, 'supersedes', 'pending', ?)
             ON CONFLICT(a_id, b_id) DO NOTHING`,
          ).bind(crypto.randomUUID(), a, b, gap, Math.log1p(gap / 86400000), now);
        }));
      }
    } catch (e) {
      console.error("Supersedes candidate accrual failed (non-fatal):", e);
    }

    // Advanced only after the work landed. A failure above leaves the cursor
    // where it was, so tomorrow re-examines this slice rather than skipping it —
    // and the UNIQUE constraint makes the repeat a no-op.
    try {
      await env.OAUTH_KV.put(ACCRUAL_CURSOR_KEY, String(seeds[seeds.length - 1].created_at));
    } catch (e) {
      console.error("Insight accrual cursor write failed (non-fatal):", e);
    }
  } catch (e) {
    console.error("Insight accrual failed (non-fatal):", e);
  }
}
