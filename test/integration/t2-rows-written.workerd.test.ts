/**
 * Track 2 Task A8 (T-0089.2.1, T-0089.2.4): rows written by the validity writes, measured on real
 * workerd D1 (local wrangler, no Cloudflare account), against spec 14 section 8.3's estimates.
 * D1 bills every index entry a write touches, so these are the numbers the free-plan ledger uses.
 * Opt in with EVAL_WORKERD=1.
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock, makeAIMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { applyStatus } from "../../src/capture/lifecycle";
import { planSupersede, supersedeStatements, updateEntryValidity, type Window } from "../../src/memory/validity";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

afterAll(cleanTemp);

/** Adds up rows_written over every statement and batch that goes through the binding. */
function metered(db: D1Database): { db: D1Database; rows: () => number; reset: () => void } {
  let total = 0;
  const wrapStmt = (s: any): any => new Proxy(s, {
    get(t, p) {
      if (p === "bind") return (...a: unknown[]) => wrapStmt(t.bind(...a));
      if (p === "all" || p === "run" || p === "raw") return async (...a: unknown[]) => { const r = await t[p](...a); total += r?.meta?.rows_written ?? 0; return r; };
      if (p === "first") return async (col?: string) => { const r = await t.all(); total += r.meta.rows_written ?? 0; const row = r.results[0] ?? null; return col && row ? row[col] : row; };
      return typeof t[p] === "function" ? t[p].bind(t) : t[p];
    },
  });
  const wrapped = new Proxy(db, {
    get(t: any, p) {
      if (p === "prepare") return (sql: string) => wrapStmt(t.prepare(sql));
      if (p === "batch") return async (stmts: any[]) => { const rs = await t.batch(stmts.map((s: any) => s)); for (const r of rs) total += r?.meta?.rows_written ?? 0; return rs; };
      return typeof t[p] === "function" ? t[p].bind(t) : t[p];
    },
  });
  return { db: wrapped, rows: () => total, reset: () => { total = 0; } };
}

async function setup() {
  const d1 = await openD1("workerd");
  resetDatabaseInit();
  const m = metered(d1.db);
  const env = makeTestEnv(undefined, { DB: m.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(), AI: makeAIMock() }) as Env;
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const ws = roots.ownerPersonalWorkspaceId;
  const seed = (id: string, createdAt: number, tags = "[]", actor = roots.ownerUserId, source = "api") =>
    d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`)
      .bind(id, `content ${id}`, tags, source, createdAt, createdAt, ws, actor).run();
  const w = (id: string, from: number): Window => ({ id, from, until: null, workspaceId: ws, status: null });
  const change = { actorId: roots.ownerUserId, channel: "rest" as const };
  return { d1, m, env, ws, seed, w, change };
}

describe.runIf(process.env.EVAL_WORKERD === "1")("Track 2 rows written on workerd", () => {
  it("supersede: version + window + edge, measured against the 8.3 estimate of 6", async () => {
    const t = await setup();
    try {
      await t.seed("old", 1000);
      await t.seed("new", 2000);
      t.m.reset();
      await t.env.DB.batch(supersedeStatements(t.env, planSupersede(t.w("old", 1000), t.w("new", 2000)), t.w("old", 1000), t.w("new", 2000), t.change, DEFAULTS));
      console.log("T2 rows written: supersede", t.m.rows());
      expect(t.m.rows()).toBe(SUPERSEDE_ROWS);
    } finally { await t.d1.close(); }
  }, 180_000);

  it("explicit validity: version + window, plus its audit event", async () => {
    const t = await setup();
    try {
      await t.seed("acme", 1000);
      t.m.reset();
      await updateEntryValidity(t.env, "acme", { until: 5000 }, t.change, DEFAULTS, t.ws);
      console.log("T2 rows written: explicit validity", t.m.rows());
      expect(t.m.rows()).toBe(EXPLICIT_ROWS);
    } finally { await t.d1.close(); }
  }, 180_000);

  it("a retraction restoring k = 1 row and flagging d = 3 dependents", async () => {
    const t = await setup();
    try {
      await t.seed("y", 1000);
      await t.seed("x", 2000);
      for (const d of ["d1", "d2", "d3"]) {
        await t.seed(d, 3000);
        await t.d1.db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES (?, ?, 'x', 'caused_by', 1, 'system', '{}', 1, 1, ?)`).bind(`e-${d}`, d, t.ws).run();
      }
      await t.env.DB.batch(supersedeStatements(t.env, planSupersede(t.w("y", 1000), t.w("x", 2000)), t.w("y", 1000), t.w("x", 2000), t.change, DEFAULTS));
      t.m.reset();
      const r = await applyStatus("x", "deprecated", t.env, t.change, DEFAULTS, t.ws);
      expect(r).toMatchObject({ validity: { restored: [{ id: "y" }], flagged: 3 } });
      console.log("T2 rows written: retraction k=1 d=3 (incl. the deprecate itself)", t.m.rows());
      expect(t.m.rows()).toBe(RETRACTION_ROWS);

      // Baseline: the same deprecate with nothing to restore or flag.
      await t.seed("plain", 4000);
      t.m.reset();
      await applyStatus("plain", "deprecated", t.env, t.change, DEFAULTS, t.ws);
      console.log("T2 rows written: plain deprecate", t.m.rows());
      expect(t.m.rows()).toBe(PLAIN_DEPRECATE_ROWS);
    } finally { await t.d1.close(); }
  }, 180_000);

  it("the upgrade: the two validity ALTERs write no rows on a brain that lacks the columns", async () => {
    const t = await setup();
    try {
      await t.seed("a", 1000);
      // A 3.7 brain: the same database without the two columns.
      await t.d1.db.exec("ALTER TABLE entries DROP COLUMN valid_until");
      await t.d1.db.exec("ALTER TABLE entries DROP COLUMN valid_from");
      resetDatabaseInit();
      t.m.reset();
      await initializeDatabase(t.env);
      const withAlters = t.m.rows();
      // The same cold start on the now-migrated brain: whatever init writes regardless of Track 2.
      resetDatabaseInit();
      t.m.reset();
      await initializeDatabase(t.env);
      console.log("T2 rows written: init with the two ALTERs", withAlters, "without", t.m.rows());
      expect(withAlters).toBe(t.m.rows());
      const cols = ((await t.d1.db.prepare("PRAGMA table_info(entries)").all()).results as any[]).map(c => c.name);
      expect(cols).toEqual(expect.arrayContaining(["valid_from", "valid_until"]));
      expect(await t.d1.db.prepare("SELECT valid_from, valid_until FROM entries WHERE id = 'a'").first()).toEqual({ valid_from: null, valid_until: null });
    } finally { await t.d1.close(); }
  }, 180_000);
});

// Measured on workerd (see the console lines); spec 14 8.3 estimates in the comments.
const PLAIN_DEPRECATE_ROWS_LITERAL = 3;
// supersede: version 2 + entries 1 + edge 6 (the row, its two unique autoindexes and idx_edges_source,
// _target, _weight). The spec's 6 counted the edge as 3; the pre-Track-2 capture paid the same 6 for
// its separate createEdge, so a contradiction writes the same rows as before Track 2 (the deprecate's
// version 2 + entries 1 are now the supersede's) and no longer deletes vectors.
const SUPERSEDE_ROWS = 9;
// explicit validity: version 2 + entries 1 + the validity_changed audit event 4 (spec est. 3 + 4).
const EXPLICIT_ROWS = 7;
const RETRACTION_ROWS = PLAIN_DEPRECATE_ROWS_LITERAL + 28;
// The deprecate itself is 3 (version 2 + entries 1); restoring k = 1 and flagging d = 3 adds exactly
// the spec's 3k + 3d + 4 per event row = 3 + 9 + 16 = 28.
const PLAIN_DEPRECATE_ROWS = 3;
