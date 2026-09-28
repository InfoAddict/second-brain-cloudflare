/**
 * Lane W follow-up (5.1 point 2): rows_read of the nightly rescan's NEEDS_RESCAN_TAG candidate
 * SELECT on local workerd D1, at 2,000 and 10,000 entries rows. Opt-in: EVAL_WORKERD=1. A `tags
 * LIKE '%...%'` predicate cannot use an index, so this is a full-table scan bounded only by the
 * LIMIT on ROWS RETURNED, not rows read — measured here so the cost is known, not assumed.
 */
import { afterAll, describe, it } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { NEEDS_RESCAN_TAG } from "../../src/quarantine/tags";

afterAll(cleanTemp);

describe.runIf(process.env.EVAL_WORKERD === "1")("quarantine rescan candidate SELECT rows_read on workerd", () => {
  it("measures at 2k and 10k entries rows", async () => {
    const results: Record<string, number> = {};
    for (const N of [2000, 10000]) {
      const d1 = await openD1("workerd");
      try {
        for (let start = 0; start < N; start += 500) {
          await d1.db.prepare(
            `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
             WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x+1 FROM c WHERE x < ?)
             SELECT 'e'||x, 'memory '||x, '["work"]', 'api', ?, '["v"]', '', '' FROM c`,
          ).bind(start + 1, Math.min(start + 500, N), Date.now()).run();
        }
        // One row queued for rescan, near the end of the table.
        await d1.db.prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
           VALUES ('needs-rescan-1', 'x', ?, 'api', ?, '[]', '', '')`,
        ).bind(JSON.stringify(["work", NEEDS_RESCAN_TAG]), Date.now()).run();

        const res = await d1.db.prepare(
          `SELECT id, content, tags, source, workspace_id, vector_ids FROM entries WHERE tags LIKE ? LIMIT ?`,
        ).bind(`%"${NEEDS_RESCAN_TAG}"%`, 10).all();
        results[`N${N}`] = (res.meta as { rows_read?: number }).rows_read ?? -1;
        console.log(`rescan candidate SELECT N=${N}: rows_read=${results[`N${N}`]}, matched=${res.results.length}`);
      } finally {
        await d1.close();
      }
    }
    console.log("quarantine rescan rows_read:", JSON.stringify(results));
  }, 120_000);
});
