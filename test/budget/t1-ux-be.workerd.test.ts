/**
 * ux-be free-tier budget audit: GET /trash and MCP list_recent(in_trash) both call the shared
 * listTrash() (src/memory/trash-list.ts, BE-1/BE-2, T-0101.2.1). R5 (budget audit, MINOR,
 * 20-free-tier-ledger.md): the original query had only deleted_at indexed, no workspace_id index,
 * so it walked the whole brain's trash — 1,193 rows read for a 50-row page at 2,000 trash rows, 5%
 * visible. idx_entries_trash_workspace_deleted (db/schema.sql) fixes that: the WHERE clause seeks
 * the index per readable workspace instead of scanning deleted_at order and filtering every row.
 * Measured here on a real workerd D1 at 2,000 trash rows. Opt in with EVAL_WORKERD=1.
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock, makeAIMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { listTrash } from "../../src/memory/trash-list";
import { DEFAULTS } from "../../src/config";
import { meterD1, type Meter } from "./t1-meter";
import type { Env } from "../../src/env";

afterAll(cleanTemp);

const N_TRASH = 2000;

describe.runIf(process.env.EVAL_WORKERD === "1")("ux-be trash listing on workerd D1, 2,000 trashed rows", () => {
  it("GET /trash's first page (listTrash) at 2,000 trash rows", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const bareEnv = makeTestEnv(undefined, { DB: d1.db, OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(), AI: makeAIMock() }) as Env;
      await initializeDatabase(bareEnv);
      const roots = await ensureTenantBootstrap(bareEnv);
      const owner = (await resolveIdentityByUserId(bareEnv, roots.ownerUserId))!;

      // 2,000 expired trash rows, but 95% of them belong to an unrelated workspace this owner
      // cannot read at all — the realistic shape for "the only index is on deleted_at, no
      // workspace_id index" (trash-list.ts's own comment): the newest-first scan has to walk past
      // every row it cannot show before it can fill a page, not just return the first 50 the
      // index handed it.
      await bareEnv.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < ${N_TRASH - 1})
         INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason)
         SELECT 't'||i, CASE WHEN i % 20 = 0 THEN ? ELSE 'other-workspace-'||(i % 50) END, ?, 'trashed content number '||i, '{"created_at":1,"source":"api"}', '[]', '[]', 2000000 + i, ?, 'rest', 'forget' FROM n`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId, roots.ownerUserId).run();

      const { db, meter } = meterD1(bareEnv.DB);
      const env = { ...bareEnv, DB: db };
      const result = await listTrash(env, owner, { limit: 50, config: DEFAULTS });
      const t = meter.totals();
      console.log(`[t1-ux-be] GET /trash page 1 @2000 trash rows: statements=${t.statementCount} subrequests=${t.subrequestCount} rows_read=${t.rowsRead} items=${result.items.length}`);

      expect(result.items.length).toBe(50);
      // R5 fixed (was: statements=2 rows_read=1,193 for 50 visible rows out of 2,000 total, 5%
      // visible — a company brain with several teams' trash the viewer cannot read is a realistic
      // way to reach that selectivity). listTrash now runs one indexed query per readable
      // workspace (idx_entries_trash_workspace_deleted, db/schema.sql) instead of one scan across
      // every workspace_id in an IN() list, so statement count scales with WORKSPACE COUNT, not
      // brain size: the admin owner here reads 3 (personal, company, the legacy '' bucket), plus
      // the deleting-client lookup (no company row in page 1, so no actor-label lookup). A solo
      // brain with no company workspace stays at the original "at most 3".
      // Measured: statements=4 subrequests=4 rows_read=207.
      expect(t.statementCount).toBeLessThanOrEqual(5);
      expect(t.subrequestCount).toBeLessThanOrEqual(5);
      // rows_read now scales with the READER'S OWN trash (bounded by their workspace membership),
      // never with the whole brain's — the 95% of rows in workspaces this reader cannot see cost
      // nothing to skip. Was 1,193 before the index; pinned here at ~1.3x measured.
      expect(t.rowsRead).toBeGreaterThan(50); // sanity: it is NOT just the 50 returned rows
      expect(t.rowsRead).toBeLessThanOrEqual(270);
    } finally { await d1.close(); }
  }, 60_000);

  it("list_recent(in_trash) is the identical listTrash call: no separate per-tool cost", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const bareEnv = makeTestEnv(undefined, { DB: d1.db, OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(), AI: makeAIMock() }) as Env;
      await initializeDatabase(bareEnv);
      const roots = await ensureTenantBootstrap(bareEnv);
      const owner = (await resolveIdentityByUserId(bareEnv, roots.ownerUserId))!;
      await bareEnv.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < ${N_TRASH - 1})
         INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason)
         SELECT 't'||i, ?, ?, 'trashed content number '||i, '{"created_at":1,"source":"api"}', '[]', '[]', 2000000 + i, ?, 'mcp', 'forget' FROM n`,
      ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId, roots.ownerUserId).run();

      const { db, meter } = meterD1(bareEnv.DB);
      const env = { ...bareEnv, DB: db };
      // list_recent(in_trash: true, n: 10) calls listTrash with limit: n (mcp/server.ts) — same
      // function GET /trash uses, so this proves the two surfaces cost the same, not a second path.
      const result = await listTrash(env, owner, { limit: 10, config: DEFAULTS });
      const t = meter.totals();
      console.log(`[t1-ux-be] list_recent(in_trash, n=10) @2000 trash rows: statements=${t.statementCount} subrequests=${t.subrequestCount} rows_read=${t.rowsRead} items=${result.items.length}`);
      expect(result.items.length).toBe(10);
      // R5: same shape as the first test — 3 workspace queries (admin owner) plus the
      // deleting-client lookup. Every row here is 100% visible (all in the owner's own personal
      // workspace), so this also proves the fix does not regress the easy case: rows_read stays
      // close to the original 45 (measured: statements=4 rows_read=47), not the 4,025 an earlier,
      // abandoned fix (a single combined workspace_id index with no query restructuring) produced
      // when SQLite chose to merge-sort across the IN() list instead of using deleted_at's own
      // order for an all-one-workspace brain.
      expect(t.statementCount).toBeLessThanOrEqual(5);
      expect(t.rowsRead).toBeLessThanOrEqual(60);
    } finally { await d1.close(); }
  }, 60_000);
});
