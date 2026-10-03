/**
 * Budget auditor (brief 19), T3/T4 lane S (S2 changes, S3 undo group), on a local workerd D1 (no Cloudflare account).
 * A brain of UG_N memories (default "2000,10000") with a 50-member status burst (UNDO_GROUP_MAX) by one MCP client
 * and 5,000 unrelated recent events (UG_OTHER=1: another tenant's MCP events; UG_QUIET=1: none; UG_HOT=1: one memory
 * edited 1,000 times, instead of noise -- the event-life filter's correlated MAX(rowid) subquery re-scans every
 * event of the SAME memory for each of that memory's own events it evaluates, so cost is quadratic in edits per
 * memory, not just in window size; UG_OTHER/UG_QUIET do not exercise this). Measures getChanges (READ_LIMIT 200)
 * and every undoGroup page (UNDO_GROUP_PAGE members each): statements (a batch as one) and rows_read. Opt-in:
 * EVAL_WORKERD=1 (UG_OUT=<file> additionally dumps the raw measurements). Requires src/brief/changes.ts with
 * UNDO_GROUP_PAGE.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { DEFAULTS } from "../../src/config";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";

afterAll(cleanTemp);
const OUT = process.env.UG_OUT;
const SIZES = (process.env.UG_N ?? "2000,10000").split(",").map(Number);
const src = resolve(__dirname, "../../src/brief/changes.ts");
const HAS_GROUP = existsSync(src) && readFileSync(src, "utf8").includes("UNDO_GROUP_PAGE");
// Round 8 re-review MINOR: `truncated` must come from the inner, pre-lifeFilter row count, not
// results.length (a reused id's earlier life could crowd real events out of the 200-row cap
// without the flag ever saying so). Getting that count costs real rows_read on top of release/v4's
// own numbers (no event-life filter, no inner-count signal at all): a window function over the
// already-capped, already-ORDER-BY'd 200-row set, measured at N=10000 with ~5% margin -- quiet
// 453 (was 302), UG_OTHER's noise 4,335 (was 4,184), UG_HOT's quadratic-shaped case 6,604 (was
// 6,003). A duplicate, non-windowed COUNT(*) statement in the same batch was tried and measured
// far worse (11,005 for the hot case: it re-reads the whole 3-way UNION/JOIN a second time,
// roughly doubling cost, instead of counting over rows already materialized once).
const CHANGES_ROWS_BUDGET = { quiet: 500, other: 4500, hot: 6700 };

function metered(db: any, t: { stmts: number; rows: number }) {
  const count = (r: any) => { t.stmts++; t.rows += r?.meta?.rows_read ?? 0; return r; };
  const wrap = (s: any): any => new Proxy(s, { get(x, p) {
    if (p === "bind") return (...a: unknown[]) => wrap(x.bind(...a));
    if (p === "all" || p === "run") return async () => count(await x[p]());
    if (p === "first") return async (col?: string) => { const r = count(await x.all()); const row = r.results[0] ?? null; return col && row ? row[col] : row; };
    if (p === "__inner") return x;
    const v = x[p]; return typeof v === "function" ? v.bind(x) : v;
  } });
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (s: any[]) => { const rs = await db.batch(s.map((y: any) => y.__inner ?? y)); t.stmts++; for (const r of rs) t.rows += r?.meta?.rows_read ?? 0; return rs; },
    exec: (q: string) => db.exec(q),
  };
}

describe.runIf(process.env.EVAL_WORKERD === "1" && HAS_GROUP)("changes and undo group on workerd", () => {
  it("measures", async () => {
    const { getChanges } = await import("../../src/brief/changes") as any;
    const { undoGroup } = await import("../../src/memory/undo") as any;
    const out: Record<string, unknown> = {};
    for (const N of SIZES) {
      const d1 = await openD1("workerd");
      try {
        resetDatabaseInit();
        await initializeDatabase(makeTestEnv(undefined, { DB: d1.db as any, OAUTH_KV: makeMemoryKV() }));
        const now = Date.now();
        const HOUR = 3_600_000, MIN = 60_000;
        for (let start = 0; start < N; start += 2000) {
          await d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
            WITH RECURSIVE c(x) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT x+1 FROM c WHERE x < ?)
            SELECT 'e'||x, 'memory '||x, CASE WHEN x <= 50 THEN '["work","status:canonical"]' ELSE '["work"]' END, 'api', ? - 10 * ? - x, '["v"]', 'ws-p', 'u1' FROM c`)
            .bind(start + 1, Math.min(start + 2000, N), now, HOUR).run();
        }
        // The burst: 50 status changes by one MCP client, one every 10 seconds, an hour ago.
        await d1.db.prepare(`INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, prior_length_utf16, tags, state, actor_id, channel, reason, meta, valid_from, created_at)
          WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 50)
          SELECT 'e'||x, 'ws-p', 1, 'memory '||x, NULL, NULL, '["work"]', '{}', 'u1', 'mcp', 'status', '{"client":"Cursor"}', NULL, ? - ? + x * 10000 FROM c`).bind(now, HOUR).run();
        await d1.db.prepare(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
          WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 50)
          SELECT 'ev-'||x, 'e'||x, 'u1', 'status_changed', '{"channel":"mcp","status":"canonical","client":"Cursor"}', ? - ? + x * 10000 FROM c`).bind(now, HOUR).run();
        // 5,000 unrelated recent events inside the same day: REST edits of the reader's own memories, or with
        // UG_OTHER=1 MCP edits by another member on 1,800 memories in another tenant's workspace. UG_HOT=1
        // replaces this with 1,000 of the reader's own MCP edits to a SINGLE memory (e500): the event-life
        // filter's correlated MAX(rowid) subquery scans every one of a memory's own events on every evaluation,
        // so spreading events across ~1,800 memories (as UG_OTHER/default do) never exercises the quadratic
        // case -- only many events on the SAME memory does.
        if (process.env.UG_HOT) {
          await d1.db.prepare(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
            WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000)
            SELECT 'hot-'||x, 'e500', 'u1', 'updated', '{"channel":"mcp"}', ? - 2 * ? + x * 1000 FROM c`).bind(now, HOUR).run();
        } else if (process.env.UG_OTHER) {
          await d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
            WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1800)
            SELECT 'o'||x, 'other '||x, '["work"]', 'api', ? - 10 * ? - x, '["v"]', 'ws-other', 'u2' FROM c`).bind(now, HOUR).run();
          await d1.db.prepare(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
            WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5000)
            SELECT 'noise-'||x, 'o'||(1 + x % 1800), 'u2', 'updated', '{"channel":"mcp"}', ? - 2 * ? + x * 1000 FROM c`).bind(now, HOUR).run();
        } else {
          await d1.db.prepare(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
            WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5000)
            SELECT 'noise-'||x, 'e'||(100 + x % 1800), 'u1', 'updated', '{"channel":"rest"}', ? - 2 * ? + x * 1000 FROM c`).bind(now, HOUR).run();
        }
        if (process.env.UG_QUIET) await d1.db.prepare(`DELETE FROM entry_events WHERE id LIKE 'noise-%' OR id LIKE 'hot-%'`).run();
        const t = { stmts: 0, rows: 0 };
        const env = makeTestEnv(undefined, { DB: metered(d1.db, t) as any, OAUTH_KV: makeMemoryKV() });
        const identity = { userId: "u1", role: "member", personalWorkspaceId: "ws-p", companyWorkspaceIds: [], defaultShare: "" };
        const cfg = { ...DEFAULTS };
        const changes = await getChanges(env, identity, now - 3 * HOUR, cfg);
        const changesCost = { ...t };
        const group = changes.items.find((i: any) => i.kind === "group");
        const pages: { stmts: number; rows: number; results: number }[] = [];
        if (group) {
          for (let i = 0; i < 20; i++) {
            t.stmts = 0; t.rows = 0;
            const r = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, cfg);
            pages.push({ ...t, results: r?.results?.length ?? 0 });
            if (!r || r.done || !r.remaining) break;
          }
        }
        out[`N${N}`] = { changes: changesCost, changesItems: changes.items.length, truncated: changes.truncated, groupSize: group?.count ?? group?.members?.length ?? null, pages };
      } finally { await d1.close(); }
    }
    if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
    // The changes read is capped at 1,000 raw events plus a bounded count probe: it must not grow with the brain.
    // FX1 d78f4c07 scopes the raw scan with `entry_id IN (SELECT id FROM entries ... UNION ALL ... entries_trash ...)`,
    // which builds the reader's whole id list twice per brief: 20,158 rows at 10k with only 50 events in the window.
    // Budget: release/v4's own numbers for the matching scenario (CHANGES_ROWS_BUDGET above) -- "at or below
    // release", not a fixed constant, since UG_HOT's own cost shape does not fit the same flat cap as the others.
    const budget = process.env.UG_HOT ? CHANGES_ROWS_BUDGET.hot : process.env.UG_QUIET ? CHANGES_ROWS_BUDGET.quiet : CHANGES_ROWS_BUDGET.other;
    for (const v of Object.values(out) as any[]) expect(v.changes.rows, "changes rows_read").toBeLessThanOrEqual(budget);
    for (const v of Object.values(out) as any[]) expect(v.pages.every((p: any) => p.stmts <= 40), `pages ${JSON.stringify(v.pages.map((p: any) => p.stmts))}`).toBe(true);
  }, 900_000);
});
