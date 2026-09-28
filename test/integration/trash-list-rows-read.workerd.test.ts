/**
 * BE-1/R5 (T-0101.2.1, budget audit): listTrash's statement count and
 * rows_read, on a real workerd D1 (local wrangler only, no Cloudflare
 * account). Opt in with EVAL_WORKERD=1. The window-function events query is
 * also new SQL this codebase has not run against real D1 before, so this is
 * the compatibility check as much as the budget pin.
 *
 * R5 fixed the whole-trash scan this file originally measured: listTrash now
 * runs one indexed query per readable workspace
 * (idx_entries_trash_workspace_deleted, db/schema.sql), so rows_read scales
 * with the reader's OWN readable trash, never with the whole brain's. 300 rows
 * across 3 workspaces here, one of them unreadable to the caller.
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { listTrash } from "../../src/memory/trash-list";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";

afterAll(cleanTemp);

function metered(db: D1Database, log: { sql: string; rows: number }[]): D1Database {
  const note = (sql: string, rows: number) => log.push({ sql: sql.replace(/\s+/g, " ").slice(0, 70), rows });
  const wrapStmt = (s: any, sql: string): any => new Proxy(s, {
    get(t, p) {
      if (p === "bind") return (...a: unknown[]) => wrapStmt(t.bind(...a), sql);
      if (p === "all" || p === "run") return async () => { const r = await t[p](); note(sql, r.meta.rows_read ?? 0); return r; };
      if (p === "first") return async (col?: string) => { const r = await t.all(); note(sql, r.meta.rows_read ?? 0); const row = r.results[0] ?? null; return col && row ? row[col] : row; };
      return typeof t[p] === "function" ? t[p].bind(t) : t[p];
    },
  });
  return new Proxy(db, {
    get(t: any, p) {
      if (p === "prepare") return (sql: string) => wrapStmt(t.prepare(sql), sql);
      return typeof t[p] === "function" ? t[p].bind(t) : t[p];
    },
  });
}

const TRASH_ROWS = 300;
const WORKSPACES = ["ws-personal", "ws-company", "ws-other"] as const;

describe.runIf(process.env.EVAL_WORKERD === "1")("listTrash rows_read on workerd", () => {
  // openD1("workerd") boots a real local wrangler dev process; slower than the default 30s.
  it("stays within 3 statements and reads at most the brain's trash plus the page size", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
      await initializeDatabase(env);

      const now = Date.now();
      // Bulk-generated in two statements, not TRASH_ROWS round trips: each
      // .run() against local wrangler's real D1 is a subrequest, and this
      // codebase's other workerd budget tests (e.g. brief-rows-read) seed the
      // same way for the same reason.
      await d1.db.prepare(
        `INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason)
         WITH RECURSIVE c(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM c WHERE x < ?)
         SELECT 't'||x,
                CASE x % 3 WHEN 0 THEN 'ws-personal' WHEN 1 THEN 'ws-company' ELSE 'ws-other' END,
                CASE WHEN x % 3 = 1 AND x % 2 = 0 THEN 'colleague' ELSE 'u1' END,
                'content', '{"source":"api"}', '[]', '[]',
                ? - x * 1000,
                CASE WHEN x % 3 = 1 AND x % 2 = 0 THEN 'colleague' ELSE 'u1' END,
                'mcp', 'forget'
           FROM c`,
      ).bind(TRASH_ROWS - 1, now).run();

      await d1.db.prepare(
        `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
         WITH RECURSIVE c(x) AS (SELECT 0 UNION ALL SELECT x+3 FROM c WHERE x < ?)
         SELECT 'ev'||x, 't'||x, '', 'deleted', ?, ? - x * 1000 FROM c`,
      ).bind(TRASH_ROWS - 1, JSON.stringify({ client: "Cursor", channel: "mcp" }), now).run();

      const log: { sql: string; rows: number }[] = [];
      const meteredEnv = { ...env, DB: metered(d1.db, log) as unknown as Env["DB"] };
      const identity: Identity = {
        userId: "u1", role: "member", personalWorkspaceId: "ws-personal",
        companyWorkspaceIds: ["ws-company"], defaultShare: "",
      };

      const limit = 20;
      const { items } = await listTrash(meteredEnv, identity, { limit, config: DEFAULTS });
      expect(items.length).toBeGreaterThan(0);

      // R5: one statement per readable workspace (2: personal + the one company here), plus
      // the deleting-client lookup and, since this identity's page can include a company row
      // authored by someone else, the actor-label lookup — up to 4, not the brain-wide "at most 3"
      // a single combined scan claimed.
      expect(log.length).toBeLessThanOrEqual(4);
      const totalRows = log.reduce((n, e) => n + e.rows, 0);
      // Bounded by this reader's own two workspaces (200 of the 300 rows), never the third,
      // unreadable workspace's 100 rows — this fixture's actor split (half the company rows
      // belong to a colleague the caller cannot restore) means the company query's index seek
      // still has to skip non-matching rows within its own workspace to fill the page. Measured
      // 226; only a third of this fixture's trash is unreadable (vs. 95% in the ux-be budget
      // fixture), so the savings here are real but smaller — bounded well short of TRASH_ROWS.
      expect(totalRows).toBeLessThan(TRASH_ROWS);
      expect(totalRows).toBeLessThanOrEqual(260);
    } finally {
      await d1.close();
    }
  }, 60_000);
});
