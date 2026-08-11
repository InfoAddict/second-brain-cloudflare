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
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.a_id, c.b_id, a.content AS a_content, b.content AS b_content
       FROM insight_candidates c
       JOIN entries a ON a.id = c.a_id
       JOIN entries b ON b.id = c.b_id
       WHERE c.status = 'pending'
       ORDER BY c.score DESC
       LIMIT ?`,
    ).bind(WEEKLY_CANDIDATE_LIMIT).all() as { results: CandidateRow[] };

    let written = 0;
    const rejected: string[] = [];
    const used: string[] = [];

    for (const candidate of results) {
      if (written >= MAX_INSIGHTS_PER_RUN) break;

      const insight = await reasonOverPair(
        { content: candidate.a_content },
        { content: candidate.b_content },
        env,
        cfg,
      );

      // A refusal is settled; a thrown call is not. reasonOverPair returns null
      // for both, so the distinction is drawn here by leaving anything that did
      // not produce an insight in `pending` only when the call itself failed.
      // In practice both land in `rejected`: re-asking a model that declined
      // costs tokens for an answer already given, and a transient failure is
      // recovered by the next accrual finding the pair again.
      if (!insight) {
        rejected.push(candidate.id);
        continue;
      }

      const content = `${insight.text}\n\n[Insight: ${insight.shape} — drawn from 2 memories]`;
      const result = await captureEntry(content, ["auto-insight"], "system", env, ctx, cfg);

      // A non-stored result means the insight duplicated an earlier one. Mark it
      // used anyway, or the pass re-proposes and re-pays for this pair forever.
      used.push(candidate.id);
      if (result.status === "stored") written++;
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
