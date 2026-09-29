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

const HOUR = 60 * 60 * 1000;

// R21 review: changeEventRows now issues a two-statement .batch() (one D1 call, per this
// codebase's own convention), which the original version of this helper never saw at all --
// .batch() has its own protocol, not the wrapped statement's .all()/.run(), so rows_read for
// anything inside a batch went uncounted. RAW lets the batch trap unwrap back to the real,
// un-proxied D1PreparedStatement before handing it to the real db.batch() (a Proxy is not safe to
// pass into D1's own batch implementation), while still logging each result's rows_read.
const RAW = Symbol("raw");
function metered(db: D1Database, log: { sql: string; rows: number }[]): D1Database {
  const note = (sql: string, rows: number) => log.push({ sql: sql.replace(/\s+/g, " ").slice(0, 70), rows });
  const wrapStmt = (s: any, sql: string): any => new Proxy(s, { get(t, p) {
    if (p === RAW) return t;
    if (p === "bind") return (...a: unknown[]) => wrapStmt(t.bind(...a), sql);
    if (p === "all" || p === "run") return async () => { const r = await t[p](); note(sql, r.meta.rows_read); return r; };
    if (p === "first") return async (col?: string) => { const r = await t.all(); note(sql, r.meta.rows_read); const row = r.results[0] ?? null; return col && row ? row[col] : row; };
    return typeof t[p] === "function" ? t[p].bind(t) : t[p];
  } });
  return new Proxy(db, { get(t: any, p) {
    if (p === "prepare") return (sql: string) => wrapStmt(t.prepare(sql), sql);
    if (p === "batch") return async (stmts: any[]) => {
      const raw = stmts.map(s => (s && s[RAW]) ? s[RAW] : s);
      const results = await t.batch(raw);
      for (const r of results) note("BATCH", r.meta?.rows_read ?? 0);
      return results;
    };
    return typeof t[p] === "function" ? t[p].bind(t) : t[p];
  } });
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
      const ctx = { waitUntil: (_: Promise<unknown>) => {} };
      const log: { sql: string; rows: number }[] = [];
      const env = makeTestEnv(undefined, { DB: metered(d1.db, log) as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
      const auth = { userId: "u1", personalWorkspaceId: "ws-p", companyWorkspaceIds: [], role: "member" } as unknown as Identity;
      const total = () => log.reduce((sum, l) => sum + l.rows, 0);
      const measure = async (run: () => Promise<unknown>) => { log.length = 0; await run(); return { rows: total(), detail: JSON.stringify(log) }; };

      const rest = await measure(() => computeBrief(env, auth, true));
      const mcp = await measure(() => computeAgentBrief(env, ctx, auth));
      const lean = await measure(() => computeLeanBrief(env, ctx, auth));
      const scoped = await measure(() => computeLeanBrief(env, ctx, auth, [project]));
      const mcpScoped = await measure(() => computeAgentBrief(env, ctx, auth, [project]));
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

/**
 * R21 review (MINOR): the changes read (5.8) had no index scoped to the reader's workspaces --
 * entry_events carries no workspace column at all -- so a 48-hour window full of OTHER people's
 * unrelated activity was scanned in full before the join and filters could drop any of it. 5,000
 * unrelated events, none belonging to this reader, used to cost 5,101 rows read to return one
 * item. The fix caps the raw pre-filter scan (RAW_EVENT_SCAN_LIMIT, src/brief/changes.ts) and
 * reports `truncated` honestly when that cap, not the reader's own 200-row output cap, is what
 * was hit. Same brain sizes as the suite above, now with 5,000 unrelated events layered on top.
 */
describe.runIf(process.env.EVAL_WORKERD === "1")("changes rows_read against 5,000 unrelated events (R21)", () => {
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
      // A dedicated, plainly-inserted entry for the reader's own genuine change -- the bulk seed
      // above builds its ids from a recursive CTE whose column is REAL-typed, so 'e'||x reads back
      // as "e1.0", not "e1"; never relied on elsewhere because nothing else looks one up by a
      // literal id, but a real id here keeps this test's own lookup honest.
      await d1.db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score, workspace_id, actor_id) VALUES (?, ?, '["work"]', 'api', ?, '["v"]', 0, 0, 'ws-p', 'u1')`,
      ).bind("reader-e1", "My own memory", now - 2 * HOUR).run();
      // This reader's own single genuine change, the most recent event in the window -- getChanges
      // reads newest-first, so its own real activity must still surface first, even once it is
      // outnumbered 5,000 to 1 by other people's unrelated, OLDER activity.
      await d1.db.prepare(
        `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind("ev-mine", "reader-e1", "u1", "status_changed", JSON.stringify({ channel: "mcp", status: "canonical" }), now - 1000).run();
      // 5,000 unrelated events: a DIFFERENT, REAL tenant's own workspace and actor (T-0102 finding
      // 7's own scenario -- another tenant's real activity, not an orphaned event row with no
      // matching entry, which the reader's new workspace-scoped semi-join would exclude for free
      // and so would not exercise the cap this test measures), spread across the rest of the 48h
      // window (2 hours to 48 hours back, all older than the genuine change above), of event types
      // getChanges' own WHERE clause would otherwise have to walk past.
      for (let start = 0; start < 5000; start += 1000) {
        await d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score, workspace_id, actor_id)
          WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x+1 FROM c WHERE x < ?)
          SELECT 'other-'||x, 'someone else''s memory '||x, '["work"]', 'api', ? - 7200000 - x * 33000, '["v"]', 0, 3, 'ws-other', 'u2'
          FROM c`).bind(start + 1, Math.min(start + 1000, 5000), now).run();
        await d1.db.prepare(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
          WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x+1 FROM c WHERE x < ?)
          SELECT 'ev-noise-'||x, 'other-'||x, 'u2', 'status_changed',
                 '{"channel":"mcp","status":"canonical"}', ? - 7200000 - x * 33000
          FROM c`).bind(start + 1, Math.min(start + 1000, 5000), now).run();
      }
      const ctx = { waitUntil: (_: Promise<unknown>) => {} };
      const log: { sql: string; rows: number }[] = [];
      const env = makeTestEnv(undefined, { DB: metered(d1.db, log) as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
      const auth = { userId: "u1", personalWorkspaceId: "ws-p", companyWorkspaceIds: [], role: "member" } as unknown as Identity;
      const total = () => log.reduce((sum, l) => sum + l.rows, 0);
      const measure = async (run: () => Promise<unknown>) => { log.length = 0; const value = await run(); return { rows: total(), value, detail: JSON.stringify(log) }; };

      const rest = await measure(() => computeBrief(env, auth, true));
      const mcp = await measure(() => computeAgentBrief(env, ctx, auth));
      const lean = await measure(() => computeLeanBrief(env, ctx, auth));
      console.log(`R21 N=${N} rows_read REST /brief=${rest.rows} MCP brief=${mcp.rows} lean brief=${lean.rows}\nREST ${rest.detail}\nchanges=${JSON.stringify((rest.value as { changes: unknown }).changes)}`);

      // R22 (budget auditor MAJOR): RAW_EVENT_SCAN_LIMIT now caps the RAW, unscoped entry_events
      // scan itself (at most 1,000 rows examined, in date order), with the entries/entries_trash
      // join and workspace-scope filter applied strictly after -- one key lookup per already-capped
      // row, so cost no longer depends on how much of the window belongs to another tenant, nor on
      // brain size. This re-accepts finding 7's original crowd-out tradeoff (a window with over
      // RAW_EVENT_SCAN_LIMIT other-tenant events can still crop the reader's own older events from
      // the list; rawCapped/truncated says so honestly) in exchange for a bound that holds
      // regardless of brain size or how adversarial the window's noise is. Measured / budget
      // (superseded by the section-35 re-budget below, kept for the R22-era baseline):
      // 2k REST 9,591/10,500 MCP 3,705/4,100 lean 3,456/3,800;
      // 10k REST 51,031/56,000 MCP 6,425/7,100 lean 5,216/5,750.
      //
      // Budget ledger section 35 (auditor re-measurement on 7af964ea): the combined changes read
      // (finding 4's actor/held-reserved branches, on top of R22's own scan) adds a flat ~1,000
      // rows in a busy window, across REST, MCP and lean alike, at both N. The auditor's own two
      // named failures -- REST 2k measured 10,595 (was budgeted 10,500), MCP 10k measured 7,429
      // (was budgeted 7,100) -- are re-budgeted to those measured numbers plus the usual ~10%
      // margin; re-measuring here found the same +1,000 shift had also pushed MCP 2k (4,709) and
      // lean at both N (4,460 / 6,220) past their own old budgets, so those three are re-budgeted
      // the same way, same section. REST 10k (52,035) still clears its existing budget.
      expect(rest.rows).toBeLessThanOrEqual(N === 2000 ? 11700 : 56000);
      expect(mcp.rows).toBeLessThanOrEqual(N === 2000 ? 5200 : 8200);
      expect(lean.rows).toBeLessThanOrEqual(N === 2000 ? 4950 : 6850);
      // Still finds the reader's own genuine change, unaffected by being outnumbered 5,000 to 1.
      expect((rest.value as { changes: { count: number } }).changes.count).toBe(1);
    } finally { await d1.close(); }
  }, 120_000);
});
