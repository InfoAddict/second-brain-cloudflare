/**
 * T-0089.2.3 (spec 14 5.8): rows_read/rows_written of the nightly staleness pass's
 * volatility-branched candidate query, on local workerd D1, at 2,000 and 10,000 entries.
 * Opt-in: EVAL_WORKERD=1. The candidate query orders by staleness_checked_at and caps at
 * STALENESS_PASS_LIMIT, so cost should stay flat as the table grows, not scale with it -
 * the thing this measurement exists to catch a regression in, now that the WHERE clause
 * branches on volatility instead of a single age cutoff.
 */
import { afterAll, describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeMemoryKV } from "../helpers/make-env";
import { runStalenessPass, STALENESS_PASS_LIMIT } from "../../src/staleness/pass";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";

afterAll(cleanTemp);
const OUT = process.env.STALE_OUT;
const SIZES = (process.env.STALE_N ?? "2000,10000").split(",").map(Number);

function metered(db: any, tally: { rowsRead: number; rowsWritten: number; calls: number }) {
  const count = (r: any) => {
    tally.calls++;
    tally.rowsRead += r?.meta?.rows_read ?? 0;
    tally.rowsWritten += r?.meta?.rows_written ?? 0;
    return r;
  };
  const wrap = (s: any): any => new Proxy(s, {
    get(t, p) {
      if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
      if (p === "all" || p === "run") return async () => count(await t[p]());
      if (p === "first") return async (col?: string) => {
        const r = count(await t.all());
        const row = r.results[0] ?? null;
        return col && row ? row[col] : row;
      };
      if (p === "__inner") return t;
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (stmts: any[]) => {
      const rs = await db.batch(stmts.map((s: any) => s.__inner ?? s));
      tally.calls++;
      for (const r of rs) { tally.rowsRead += r?.meta?.rows_read ?? 0; tally.rowsWritten += r?.meta?.rows_written ?? 0; }
      return rs;
    },
    exec: (q: string) => db.exec(q),
  };
}

describe.runIf(process.env.EVAL_WORKERD === "1")("runStalenessPass rows_read/written on workerd", () => {
  it("measures at 2k and 10k entries", async () => {
    const out: Record<string, Record<string, number>> = {};
    for (const N of SIZES) {
      const d1 = await openD1("workerd");
      try {
        resetDatabaseInit();
        const kv = makeMemoryKV();
        const boot = { DB: d1.db, OAUTH_KV: kv } as any;
        await initializeDatabase(boot);
        setDbReady(true);
        const now = Date.now();
        // Half volatile, half state, all aged well past both the 14- and 90-day defaults, and
        // never yet checked: a realistic full candidate pool, not an empty table.
        const old = now - 200 * 86400000;
        for (let start = 0; start < N; start += 500) {
          await d1.db.prepare(
            `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
             WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x+1 FROM c WHERE x < ?)
             SELECT 'e'||x, 'memory '||x||' about the quarterly plan', CASE WHEN x % 2 = 0 THEN '["volatility:volatile"]' ELSE '["volatility:state"]' END,
                    'api', ? - x, ? - x, '["v"]', '', '' FROM c`,
          ).bind(start + 1, Math.min(start + 500, N), old, old).run();
        }

        const tally = { rowsRead: 0, rowsWritten: 0, calls: 0 };
        const env = { DB: metered(d1.db, tally) as any, OAUTH_KV: kv } as any;

        const { flagged } = await runStalenessPass(env, {} as ExecutionContext);
        out[`N${N}`] = { rowsRead: tally.rowsRead, rowsWritten: tally.rowsWritten, calls: tally.calls, flagged };
        console.log(`runStalenessPass N=${N}:`, JSON.stringify(out[`N${N}`]));
      } finally {
        await d1.close();
      }
    }
    console.log("runStalenessPass rows_read/written:", JSON.stringify(out));
    console.log(`STALENESS_PASS_LIMIT=${STALENESS_PASS_LIMIT}`);
    if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
  }, 300_000);
});
