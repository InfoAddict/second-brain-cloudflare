/**
 * Budget auditor (brief 19): rows_read of the current-reader routes through the real Worker on a local workerd D1
 * (no Cloudflare account), at READER_N memories (default "2000,10000"): GET /list?n=50, GET /entry, GET /recall
 * (synthesize=0), GET /brief?lean=1. Opt-in: EVAL_WORKERD=1 and READER_OUT=<file>. Identity is resolved for real
 * (tenant bootstrap), so each figure includes the identity read.
 */
import { afterAll, describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";

afterAll(cleanTemp);
const OUT = process.env.READER_OUT;
const SIZES = (process.env.READER_N ?? "2000,10000").split(",").map(Number);

function metered(db: any, tally: { rows: number; stmts: number }) {
  const count = (r: any) => { tally.stmts++; tally.rows += r?.meta?.rows_read ?? 0; return r; };
  const wrap = (s: any): any => new Proxy(s, { get(t, p) {
    if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
    if (p === "all" || p === "run") return async () => count(await t[p]());
    if (p === "first") return async (col?: string) => { const r = count(await t.all()); const row = r.results[0] ?? null; return col && row ? row[col] : row; };
    if (p === "__inner") return t;
    const v = t[p]; return typeof v === "function" ? v.bind(t) : v;
  } });
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (s: any[]) => { const rs = await db.batch(s.map((x: any) => x.__inner ?? x)); tally.stmts++; for (const r of rs) tally.rows += r?.meta?.rows_read ?? 0; return rs; },
    exec: (q: string) => db.exec(q),
  };
}

describe.runIf(process.env.EVAL_WORKERD === "1" && OUT)("reader rows_read on workerd", () => {
  it("measures", async () => {
    const out: Record<string, Record<string, number>> = {};
    for (const N of SIZES) {
      const d1 = await openD1("workerd");
      try {
        resetDatabaseInit();
        const kv = makeMemoryKV();
        const boot = makeTestEnv(undefined, { DB: d1.db as any, OAUTH_KV: kv });
        await initializeDatabase(boot);
        const roots = await ensureTenantBootstrap(boot);
        const ws = roots.ownerPersonalWorkspaceId;
        const now = Date.now();
        for (let start = 0; start < N; start += 2000) {
          await d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
            WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x+1 FROM c WHERE x < ?)
            SELECT 'e'||x, 'memory '||x||' about the atlas ledger and the quarterly plan', CASE WHEN x % 20 = 0 THEN '["task","work"]' ELSE '["work"]' END,
                   'api', ? - x * 3600000, '["v"]', ?, '' FROM c`).bind(start + 1, Math.min(start + 2000, N), now, ws).run();
        }
        const tally = { rows: 0, stmts: 0 };
        const env = makeTestEnv(undefined, { DB: metered(d1.db, tally) as any, OAUTH_KV: kv });
        const ctx = { waitUntil: () => {} } as any;
        const row: Record<string, number> = {};
        for (const [name, path] of [["list50", "/list?n=50"], ["entry", "/entry?id=e40"], ["recall", "/recall?query=atlas+ledger+plan&topK=10&synthesize=0"], ["leanBrief", "/brief?lean=1&preview=1"]] as const) {
          tally.rows = 0; tally.stmts = 0;
          const res = await worker.fetch(new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer test-token" } }), env, ctx);
          await res.text();
          row[name] = tally.rows; row[`${name}Stmts`] = tally.stmts; row[`${name}Status`] = res.status;
        }
        out[`N${N}`] = row;
      } finally { await d1.close(); }
    }
    writeFileSync(OUT!, JSON.stringify(out, null, 1));
  }, 600_000);
});
