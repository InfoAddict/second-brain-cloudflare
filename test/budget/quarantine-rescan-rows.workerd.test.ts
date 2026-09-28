/**
 * Budget auditor R19 (T-0089.4.2, class D): the nightly rescan's candidate read used to be a
 * full table scan (`tags LIKE '%...%'`, no index possible). It is now index-backed —
 * idx_entries_quarantine_pending_scan, a partial index whose WHERE the query matches verbatim
 * (instr(lower(tags), ...), the ledger index's own pattern) — so rows_read stays a small,
 * roughly-constant handful regardless of corpus size, measured here at 2,000 and 10,000 entries
 * rows on local workerd D1. Opt-in: EVAL_WORKERD=1.
 */
import { afterAll, describe, it } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { withHold } from "../../src/quarantine/tags";
import type { Env } from "../../src/env";

afterAll(cleanTemp);

describe.runIf(process.env.EVAL_WORKERD === "1")("quarantine rescan candidate SELECT rows_read on workerd", () => {
  it("measures at 2k and 10k entries rows", async () => {
    const results: Record<string, number> = {};
    for (const N of [2000, 10000]) {
      const d1 = await openD1("workerd");
      try {
        resetDatabaseInit();
        await initializeDatabase({ DB: d1.db } as unknown as Env);

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
           VALUES ('pending-scan-1', 'x', ?, 'api', ?, '[]', '', '')`,
        ).bind(JSON.stringify(withHold(["work"], "pending-scan")), Date.now()).run();

        const res = await d1.db.prepare(
          `SELECT id, content, tags, source, workspace_id, vector_ids FROM entries
           WHERE instr(lower(tags), '"quarantine:pending-scan"') > 0 LIMIT 10`,
        ).all();
        results[`N${N}`] = (res.meta as { rows_read?: number }).rows_read ?? -1;
        console.log(`rescan candidate SELECT N=${N}: rows_read=${results[`N${N}`]}, matched=${res.results.length}`);
      } finally {
        await d1.close();
      }
    }
    console.log("quarantine rescan rows_read:", JSON.stringify(results));
  }, 120_000);
});
