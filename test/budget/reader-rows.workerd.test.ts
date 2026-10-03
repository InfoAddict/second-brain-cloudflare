/**
 * Budget auditor (brief 19): rows_read of the current-reader routes through the real Worker on a local workerd D1
 * (no Cloudflare account), at READER_N memories (default "2000,10000"): GET /list?n=50, GET /entry, GET /recall
 * (synthesize=0; READER_FTS=1 marks the FTS index ready, otherwise the keyword arm runs its LIKE fallback; a common-term query and a rare-term one, plus as-of variants with READER_ASOF=1), GET /brief?lean=1. Opt-in: EVAL_WORKERD=1 and READER_OUT=<file>. Identity is resolved for real
 * (tenant bootstrap), so each figure includes the identity read.
 *
 * READER_STANDING=1 seeds one standing:active row whose cached vector always scores above
 * STANDING_THRESHOLD under this harness's constant-vector AI double, so "recall"/"recallRare"
 * then measure the standing fire path's own worst case (its hydration arm always runs) instead
 * of the no-cache baseline every other run measures.
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

function metered(db: any, tally: { rows: number; stmts: number; log?: string[] }) {
  let last = "";
  const count = (r: any) => { tally.stmts++; tally.rows += r?.meta?.rows_read ?? 0; tally.log?.push(`${r?.meta?.rows_read ?? 0} ${last}`); return r; };
  const wrap = (s: any, sql = ""): any => new Proxy(s, { get(t, p) {
    if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a), sql);
    if (p === "all" || p === "run" || p === "first") last = sql;
    if (p === "all" || p === "run") return async () => count(await t[p]());
    if (p === "first") return async (col?: string) => { const r = count(await t.all()); const row = r.results[0] ?? null; return col && row ? row[col] : row; };
    if (p === "__inner") return t;
    const v = t[p]; return typeof v === "function" ? v.bind(t) : v;
  } });
  return {
    prepare: (sql: string) => wrap(db.prepare(sql), sql.replace(/\s+/g, " ").slice(0, 110)),
    batch: async (s: any[]) => { const rs = await db.batch(s.map((x: any) => x.__inner ?? x)); tally.stmts++; for (const r of rs) tally.rows += r?.meta?.rows_read ?? 0; tally.log?.push(`${rs.reduce((a: number, r: any) => a + (r?.meta?.rows_read ?? 0), 0)} BATCH[${rs.map((r: any) => r?.meta?.rows_read ?? 0).join(",")}]`); return rs; },
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
            SELECT 'e'||x, 'memory '||x||' about the atlas ledger and the quarterly plan'||CASE WHEN x % 100 = 7 THEN ' with the zebra vendor' ELSE '' END, CASE WHEN x % 20 = 0 THEN '["task","work"]' ELSE '["work"]' END,
                   'api', ? - x * 3600000, '["v"]', ?, '' FROM c`).bind(start + 1, Math.min(start + 2000, N), now, ws).run();
        }
        if (process.env.READER_FTS) {
          const { FTS_READY_KV_KEY } = await import("../../src/constants");
          await kv.put(FTS_READY_KV_KEY, "1");
        }
        // Track 7 lane D Task 11: one standing:active row that always fires under this harness's
        // AI double, which embeds every text to the same constant vector regardless of content
        // (see makeAIMock) — so a cache item encoded from that same constant is guaranteed to score
        // above STANDING_THRESHOLD on every query, measuring the fire path's own worst case (it
        // always adds its hydration arm) rather than depending on real semantic similarity.
        if (process.env.READER_STANDING) {
          const { encodeVector } = await import("../../src/standing/codec");
          const { standingKvKey } = await import("../../src/standing/cache");
          await d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
            VALUES ('e-standing', 'when the zebra vendor comes up, escalate to finance', '["standing:active"]', 'api', ?, '["v-standing"]', ?, '')`)
            .bind(now, ws).run();
          await kv.put(standingKvKey(ws), JSON.stringify({
            v: 1, model: "@cf/baai/bge-small-en-v1.5", dim: 384, builtAt: now,
            items: [{ id: "e-standing", projects: [], createdAt: now, vecs: [encodeVector(new Array(384).fill(0.1))] }],
          }));
        }
        const tally: { rows: number; stmts: number; log?: string[] } = { rows: 0, stmts: 0, log: process.env.READER_DETAIL ? [] : undefined };
        const env = makeTestEnv(undefined, { DB: metered(d1.db, tally) as any, OAUTH_KV: kv });
        const ctx = { waitUntil: () => {} } as any;
        const row: Record<string, number> = {};
        for (const [name, path] of [["list50", "/list?n=50"], ["entry", "/entry?id=e40"], ["recall", "/recall?query=atlas+ledger+plan&topK=10&synthesize=0"], ["leanBrief", "/brief?lean=1&preview=1"],
          ["recallRare", "/recall?query=zebra+vendor&topK=10&synthesize=0"],
          ...(process.env.READER_ASOF ? [
            ["recallAsOf", `/recall?query=atlas+ledger+plan&topK=10&synthesize=0&as_of=${new Date(now).toISOString().slice(0, 10)}`],
            ["recallRareAsOf", `/recall?query=zebra+vendor&topK=10&synthesize=0&as_of=${new Date(now).toISOString().slice(0, 10)}`],
          ] : [])] as const) {
          tally.rows = 0; tally.stmts = 0; if (tally.log) tally.log.length = 0;
          const res = await worker.fetch(new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer test-token" } }), env, ctx);
          await res.text();
          row[name] = tally.rows; row[`${name}Stmts`] = tally.stmts; row[`${name}Status`] = res.status;
          if (tally.log) (row as any)[`${name}Detail`] = [...tally.log];
        }
        out[`N${N}`] = row;
      } finally { await d1.close(); }
    }
    writeFileSync(OUT!, JSON.stringify(out, null, 1));
  }, 600_000);
});
