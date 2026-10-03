/**
 * W7 (16-t3-t4-trust-spec.md 5.2, 5.4): rows_read of the scorer's one new D1 read
 * (countMcpWritesInWindow) on local workerd D1, at 2,000 and 10,000 entry_events rows. Opt-in:
 * EVAL_WORKERD=1. Bounded by the 10-minute window and the LIMIT, not by table size.
 */
import { afterAll, describe, it } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { countMcpWritesInWindow } from "../../src/quarantine/burst";

afterAll(cleanTemp);

describe.runIf(process.env.EVAL_WORKERD === "1")("countMcpWritesInWindow rows_read on workerd", () => {
  it("measures at 2k and 10k entry_events rows", async () => {
    const results: Record<string, number> = {};
    for (const N of [2000, 10000]) {
      const d1 = await openD1("workerd");
      try {
        const now = Date.now();
        // Most rows outside the 10-minute window (other actors, older times); 39 inside it for
        // the actor being scored, so the index seek plus LIMIT bound the read regardless of N.
        for (let start = 0; start < N; start += 500) {
          await d1.db.prepare(
            `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
             WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x+1 FROM c WHERE x < ?)
             SELECT 'ev'||x, 'e'||x, 'other-actor', 'created', '{"channel":"mcp"}', ? - x * 3600000 FROM c`,
          ).bind(start + 1, Math.min(start + 500, N), now).run();
        }
        for (let i = 0; i < 39; i++) {
          await d1.db.prepare(
            `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, 'scored-actor', 'created', '{"channel":"mcp"}', ?)`,
          ).bind(`burst-ev-${i}`, `burst-e-${i}`, now - 1000).run();
        }

        const tally = { rows: 0 };
        const metered = {
          prepare: (sql: string) => {
            const stmt = d1.db.prepare(sql);
            return {
              bind: (...args: unknown[]) => {
                const bound = stmt.bind(...args);
                return {
                  first: async <T>() => {
                    const r = await (bound as any).all();
                    tally.rows += r?.meta?.rows_read ?? 0;
                    return (r.results?.[0] ?? null) as T;
                  },
                };
              },
            };
          },
        };

        const n = await countMcpWritesInWindow({ DB: metered as any } as any, "scored-actor", now, 40);
        console.log(`countMcpWritesInWindow N=${N}: n=${n}, rows_read=${tally.rows}`);
        results[`N${N}`] = tally.rows;
      } finally {
        await d1.close();
      }
    }
    console.log("countMcpWritesInWindow rows_read:", JSON.stringify(results));
  }, 120_000);
});
