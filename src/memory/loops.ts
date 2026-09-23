/**
 * The open-loops queue, as a WHERE clause.
 *
 * Live counts against prod D1 (2026-09-21): 523 entries carry "task" without
 * "status:deprecated" — deprecation is not a completion signal, only 13 rows
 * were ever deprecated. Excluding agent-log tags (claude-response,
 * codex-response, build-log, resume-playbook) leaves 192 real candidates, a
 * mix of user commitments and agent build notes without a done signal.
 *
 * One definition, shared by GET /loops's queue, its count, and the count
 * folded into GET /brief's attention aggregate — the same reason
 * STALE_REVIEW_SQL is shared (src/memory/stale.ts): a chip that promises a
 * number the queue then fails to produce is the defect that predicate exists
 * to prevent, and one predicate is what stops it recurring here.
 */
export const OPEN_LOOP_SQL = `tags LIKE '%"task"%'
         AND tags NOT LIKE '%"status:deprecated"%'
         AND tags NOT LIKE '%"task:done"%'
         AND tags NOT LIKE '%"claude-response"%'
         AND tags NOT LIKE '%"codex-response"%'
         AND tags NOT LIKE '%"build-log"%'
         AND tags NOT LIKE '%"resume-playbook"%'`;

export const TASK_DONE_TAG = "task:done";

/** "done" resolution: mark closed without removing the "task" tag. */
export function withTaskDone(tags: string[]): string[] {
  if (tags.includes(TASK_DONE_TAG)) return tags;
  return [...tags, TASK_DONE_TAG];
}

/** "not-task" resolution: this was never a commitment, drop the tag outright. */
export function withoutTask(tags: string[]): string[] {
  return tags.filter(t => t !== "task");
}
