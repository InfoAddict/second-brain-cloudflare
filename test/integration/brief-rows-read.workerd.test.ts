/**
 * rows_read of the brief paths on a real workerd D1 (local wrangler only, no Cloudflare account).
 * D1's free plan allows 5M rows read per day account-wide, and every session start runs a brief,
 * so the row count is the budget that matters, not the statement count. Opt in with EVAL_WORKERD=1.
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { computeBrief, computeAgentBrief, computeLeanBrief } from "../../src/brief/compute";
import type { Env } from "../../src/env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import type { Identity } from "../../src/lib/identity";
import type { ProjectRow } from "../../src/projects/registry";

// wrangler and Miniflare leave a miniflare-* dir behind even after dispose().
afterAll(cleanTemp);

function metered(db: D1Database, log: { sql: string; rows: number }[]): D1Database {
  const note = (sql: string, rows: number) => log.push({ sql: sql.replace(/\s+/g, " ").slice(0, 70), rows });
  const wrapStmt = (s: any, sql: string): any => new Proxy(s, { get(t, p) {
    if (p === "bind") return (...a: unknown[]) => wrapStmt(t.bind(...a), sql);
    if (p === "all" || p === "run") return async () => { const r = await t[p](); note(sql, r.meta.rows_read); return r; };
    if (p === "first") return async (col?: string) => { const r = await t.all(); note(sql, r.meta.rows_read); const row = r.results[0] ?? null; return col && row ? row[col] : row; };
    return typeof t[p] === "function" ? t[p].bind(t) : t[p];
  } });
  return new Proxy(db, { get(t: any, p) { if (p === "prepare") return (sql: string) => wrapStmt(t.prepare(sql), sql); return typeof t[p] === "function" ? t[p].bind(t) : t[p]; } });
}

// Rows read per brief path, by memory count, measured on workerd with the mix seeded below (5% tasks,
// 2% pending insights, 1% stale, 0.5% dated). Measured / budget:
//   2k:  MCP 684 / 900    lean 442 / 600     REST /brief 6,162 / 6,800
//   10k: MCP 3,404 / 4,500  lean 2,202 / 3,000  REST /brief 46,002 / 50,500
// With a 16-alias project (LIKE-OR, the registry cap; a json_each filter billed every scanned row and read 154k):
//   2k:  MCP 565 / 900  lean 442 / 600  REST 8,045 / 8,800
//   10k: MCP 2,805 / 4,500  lean 2,202 / 3,000  REST 55,885 / 61,500
// The MCP and lean budgets are ~1.3x measured: they read only the rows their queue holds (the open-task
// count visits each of the ~500 tasks at 10k, about four reads apiece), so they grow with the queue, not
// the brain, and the margin absorbs SQLite planner drift without hiding a return to full scans.
// REST /brief is the dashboard's own path and still scans; it is pinned at ~1.1x only as a regression guard.
// Before the partial indexes: MCP brief 8,232 / 41,112 rows, so a hook plus agent brief cost ~87k per session start at 10k.
// D1's free plan allows 5M rows read per day account-wide; lean at 10k is ~2.2k, about 2,300 session starts.
const BUDGET: Record<number, { mcp: number; lean: number; rest: number; restScoped: number }> = {
  2000: { mcp: 900, lean: 600, rest: 6800, restScoped: 8800 },
  10000: { mcp: 4500, lean: 3000, rest: 50500, restScoped: 61500 },
};

// 16 aliases is the registry cap (MAX_PROJECT_ALIASES); 'work' matches every seeded row, so the filter
// keeps rows instead of short-circuiting, and 17 LIKE patterns are OR-ed on each.
const project: ProjectRow = { id: "work", workspace_id: "ws-p", name: "Work", description: "", status: "active", aliases: ["work", ...Array.from({ length: 15 }, (_, i) => `alias-${i}`)], created_at: 1, updated_at: null };

describe.runIf(process.env.EVAL_WORKERD === "1")("brief rows_read on workerd", () => {
  for (const N of [2000, 10000]) it(`N=${N}`, async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      await initializeDatabase(makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
      const now = Date.now();
      for (let start = 0; start < N; start += 2000) {
        await d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score, workspace_id, actor_id, when_at, when_kind, when_source)
          WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x+1 FROM c WHERE x < ?)
          SELECT 'e'||x, 'memory '||x,
                 CASE WHEN x % 20 = 0 THEN '["task","work"]' WHEN x % 50 = 1 THEN '["auto-insight"]' WHEN x % 100 = 2 THEN '["work","stale:as-of"]' ELSE '["work","kind:semantic"]' END,
                 'api', ? - x * 3600000, '["v"]', 0, 3, 'ws-p', 'u1',
                 CASE WHEN x % 200 = 0 THEN ? + 3600000 ELSE NULL END, CASE WHEN x % 200 = 0 THEN 'due' ELSE NULL END, CASE WHEN x % 200 = 0 THEN 'explicit' ELSE NULL END
          FROM c`).bind(start + 1, Math.min(start + 2000, N), now, now).run();
      }
      const log: { sql: string; rows: number }[] = [];
      const env = makeTestEnv(undefined, { DB: metered(d1.db, log) as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
      const auth = { userId: "u1", personalWorkspaceId: "ws-p", companyWorkspaceIds: [], role: "member" } as unknown as Identity;
      const total = () => log.reduce((sum, l) => sum + l.rows, 0);
      const measure = async (run: () => Promise<unknown>) => { log.length = 0; await run(); return { rows: total(), detail: JSON.stringify(log) }; };

      const rest = await measure(() => computeBrief(env, auth, true));
      const mcp = await measure(() => computeAgentBrief(env, auth));
      const lean = await measure(() => computeLeanBrief(env, auth));
      const scoped = await measure(() => computeLeanBrief(env, auth, [project]));
      const mcpScoped = await measure(() => computeAgentBrief(env, auth, [project]));
      const restScoped = await measure(() => computeBrief(env, auth, true, [project]));
      console.log(`N=${N} rows_read REST /brief=${rest.rows} MCP brief=${mcp.rows} lean brief=${lean.rows} with a 16-alias project: REST=${restScoped.rows} MCP=${mcpScoped.rows} lean=${scoped.rows}\nMCP ${mcp.detail}\nLEAN ${lean.detail}`);
      const budget = BUDGET[N];
      expect(mcp.rows).toBeLessThanOrEqual(budget.mcp);
      expect(lean.rows).toBeLessThanOrEqual(budget.lean);
      expect(scoped.rows).toBeLessThanOrEqual(budget.lean);
      expect(mcpScoped.rows).toBeLessThanOrEqual(budget.mcp);
      expect(restScoped.rows).toBeLessThanOrEqual(budget.restScoped);
      expect(rest.rows).toBeLessThanOrEqual(budget.rest);
    } finally { await d1.close(); }
  }, 120_000);
});
