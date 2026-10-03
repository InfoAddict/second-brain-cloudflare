/**
 * Common-term recall rows_read on workerd (ledger sections 17 and 39): the reader-rows corpus, FTS ready, at 2k and 10k.
 * "Steady" is the second common-term recall, after the first has paid the one-time tag-vocabulary rebuild.
 * BEFORE is db8212f0 measured by this test (each figure includes the previous call's 40-row recall_count update). Opt-in: EVAL_WORKERD=1 (boots a local workerd D1, no Cloudflare account).
 */
import { afterAll, describe, expect, it } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { resetFtsReadyMemo } from "../../src/recall/fts";

afterAll(cleanTemp);

const BEFORE: Record<number, { common: number; rare: number; rareAsOf: number }> = {
  2000: { common: 19_263, rare: 476, rareAsOf: 559 },
  10000: { common: 37_270, rare: 1_356, rareAsOf: 1_439 },
};

function metered(db: any, tally: { rows: number }) {
  const wrap = (s: any): any => new Proxy(s, { get(t, p) {
    if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
    if (p === "all" || p === "run") return async () => { const r = await t[p](); tally.rows += r?.meta?.rows_read ?? 0; return r; };
    if (p === "first") return async (col?: string) => { const r = await t.all(); tally.rows += r?.meta?.rows_read ?? 0; const row = r.results[0] ?? null; return col && row ? row[col] : row; };
    if (p === "__inner") return t;
    const v = t[p]; return typeof v === "function" ? v.bind(t) : v;
  } });
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (s: any[]) => { const rs = await db.batch(s.map((x: any) => x.__inner ?? x)); for (const r of rs) tally.rows += r?.meta?.rows_read ?? 0; return rs; },
    exec: (q: string) => db.exec(q),
  };
}

describe.runIf(process.env.EVAL_WORKERD === "1")("common-term recall rows_read on workerd", () => {
  for (const N of [2000, 10000]) {
    it(`cuts steady common-term rows by at least 60% at ${N}, with no rare or as-of regression`, async () => {
      const d1 = await openD1("workerd");
      try {
        resetDatabaseInit();
        resetFtsReadyMemo();
        const kv = makeMemoryKV();
        const boot = makeTestEnv(undefined, { DB: d1.db as any, OAUTH_KV: kv });
        await initializeDatabase(boot);
        const ws = (await ensureTenantBootstrap(boot)).ownerPersonalWorkspaceId;
        const now = Date.now();
        for (let start = 0; start < N; start += 2000) {
          await d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
            WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x+1 FROM c WHERE x < ?)
            SELECT 'e'||x, 'memory '||x||' about the atlas ledger and the quarterly plan'||CASE WHEN x % 100 = 7 THEN ' with the zebra vendor' ELSE '' END, CASE WHEN x % 20 = 0 THEN '["task","work"]' ELSE '["work"]' END,
                   'api', ? - x * 3600000, '["v"]', ?, '' FROM c`).bind(start + 1, Math.min(start + 2000, N), now, ws).run();
        }
        await kv.put(FTS_READY_KV_KEY, "1");
        const tally = { rows: 0 };
        const env = makeTestEnv(undefined, { DB: metered(d1.db, tally) as any, OAUTH_KV: kv });
        const rowsOf = async (path: string) => {
          tally.rows = 0;
          const res = await worker.fetch(new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer test-token" } }), env, { waitUntil: () => {} } as any);
          expect(res.status).toBe(200);
          await res.text();
          return tally.rows;
        };
        const day = new Date(now).toISOString().slice(0, 10);
        await rowsOf("/recall?query=atlas+ledger+plan&topK=10&synthesize=0"); // pays the tag-vocabulary rebuild
        const common = await rowsOf("/recall?query=atlas+ledger+plan&topK=10&synthesize=0");
        const rare = await rowsOf("/recall?query=zebra+vendor&topK=10&synthesize=0");
        const rareAsOf = await rowsOf(`/recall?query=zebra+vendor&topK=10&synthesize=0&as_of=${day}`);
        const before = BEFORE[N];
        console.log(JSON.stringify({ N, common, rare, rareAsOf, before }));
        expect(common, `steady common-term rows at ${N}`).toBeLessThanOrEqual(Math.floor(before.common * 0.4));
        expect(rare, `rare-term rows at ${N}`).toBeLessThanOrEqual(before.rare);
        expect(rareAsOf, `rare-term as-of rows at ${N}`).toBeLessThanOrEqual(before.rareAsOf);
      } finally {
        await d1.close();
      }
    }, 600_000);
  }
});
