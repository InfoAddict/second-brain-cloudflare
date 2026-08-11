/**
 * The weekly reasoning pass.
 *
 * Does no searching: nightly accrual has already left scored pairs in
 * insight_candidates, so this reads an ordered slice and spends its whole
 * budget on reasoning.
 *
 * Producing nothing is a correct outcome. The generator this replaces made 136
 * proposals and none were ever promoted; three filler insights a week is how a
 * review queue becomes something its owner stops opening.
 */
import type { Env } from "../env";
import { resolveConfig } from "../config";
import { initializeDatabase } from "../db/init";
import { captureEntry } from "../capture/entry";
import { reasonOverPair } from "./reason";

/** Pairs considered per run. Each costs one model call. */
export const WEEKLY_CANDIDATE_LIMIT = 10;

/** Written per run, however many qualify. */
export const MAX_INSIGHTS_PER_RUN = 3;

interface CandidateRow {
  id: string;
  a_id: string;
  b_id: string;
  a_content: string;
  b_content: string;
}

export async function runWeeklyInsights(env: Env, ctx: ExecutionContext): Promise<void> {
  try {
    const cfg = await resolveConfig(env);
    await initializeDatabase(env);

    // One statement rather than a select-then-hydrate: the join is what keeps
    // this inside the subrequest budget, and a candidate whose entries have
    // since been forgotten drops out of the result rather than needing a guard.
    //
    // The deprecation check is the same reasoning applied to a candidate whose
    // entries still exist but should no longer be reasoned over: accrual is
    // nightly and this is weekly, so up to seven days can pass between a pair
    // being accrued and being read here, and a `supersedes` edge deprecates its
    // target the moment it is created (src/capture/entry.ts). Filtering both
    // sides here catches that drift regardless of which signal accrued the
    // candidate or how eligibility was — or was not — checked at accrual time.
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.a_id, c.b_id, a.content AS a_content, b.content AS b_content
       FROM insight_candidates c
       JOIN entries a ON a.id = c.a_id
       JOIN entries b ON b.id = c.b_id
       WHERE c.status = 'pending'
         AND a.tags NOT LIKE '%"status:deprecated"%'
         AND b.tags NOT LIKE '%"status:deprecated"%'
       ORDER BY c.score DESC
       LIMIT ?`,
    ).bind(WEEKLY_CANDIDATE_LIMIT).all() as { results: CandidateRow[] };

    let written = 0;
    const rejected: string[] = [];
    const used: string[] = [];

    for (const candidate of results) {
      if (written >= MAX_INSIGHTS_PER_RUN) break;

      const result = await reasonOverPair(
        { content: candidate.a_content },
        { content: candidate.b_content },
        env,
        cfg,
      );

      // A refusal is settled; a thrown call is not. reasonOverPair now says
      // which one happened instead of returning null for both. A "declined"
      // candidate is marked `rejected` below — re-asking a model that has
      // already answered costs tokens for a response already given. A "failed"
      // candidate is left untouched in `pending`: nothing was decided, and
      // re-accrual cannot resurrect a `rejected` row (`ON CONFLICT DO NOTHING`
      // leaves its status alone), so the only way a transient failure gets a
      // second chance is by never having been marked settled in the first
      // place.
      if (result.outcome === "failed") continue;
      if (result.outcome === "declined") {
        rejected.push(candidate.id);
        continue;
      }

      const content = `${result.text}\n\n[Insight: ${result.shape} — drawn from 2 memories]`;
      const captured = await captureEntry(content, ["auto-insight"], "system", env, ctx, cfg);

      // A non-stored result means the insight duplicated an earlier one. Mark it
      // used anyway, or the pass re-proposes and re-pays for this pair forever.
      used.push(candidate.id);
      if (captured.status === "stored") written++;
    }

    const statements = [
      ...rejected.map(id => env.DB.prepare(
        `UPDATE insight_candidates SET status = 'rejected' WHERE id = ?`).bind(id)),
      ...used.map(id => env.DB.prepare(
        `UPDATE insight_candidates SET status = 'used' WHERE id = ?`).bind(id)),
    ];
    if (statements.length) await env.DB.batch(statements);
  } catch (e) {
    console.error("Weekly insight pass failed (non-fatal):", e);
  }
}
