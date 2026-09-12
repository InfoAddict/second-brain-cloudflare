/**
 * #347 locked decision 5: a batch of 10 moved entries must stay well inside
 * the free-plan 50-subrequest ceiling. Per the data contract's arithmetic
 * (docs/superpowers/plans/2026-09-12-347-data-contract.md §4), one moved entry
 * costs 2 D1 executions (moveEntry's own scoped SELECT, plus its 2-statement
 * env.DB.batch(), which bills as 1 execution) — so worst case should be around
 * 20 for a batch of 10, nowhere near 50. This is an assertion, not a comment,
 * modelled on test/unit/cron-subrequest-budget.test.ts's countingEnv pattern.
 */
import { describe, it, expect } from "vitest";
import worker from "../../src/index";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { captureEntry } from "../../src/capture/entry";
import type { Env } from "../../src/env";

const FREE_PLAN_SUBREQUESTS = 50;

// D1 bills EXECUTIONS: run/first/all/exec spend one each, and batch() spends
// one however many statements it carries — same accounting rule as
// cron-subrequest-budget.test.ts, so the two budgets stay comparable.
function countingD1(sqliteDb: any) {
  const statements: string[] = [];
  const bill = (sql: string) => statements.push(sql.replace(/\s+/g, " ").trim());
  const wrap = (stmt: any, sql: string): any => ({
    bind: (...a: any[]) => wrap(stmt.bind(...a), sql),
    run: () => { bill(sql); return stmt.run(); },
    first: (...a: any[]) => { bill(sql); return stmt.first(...a); },
    all: () => { bill(sql); return stmt.all(); },
    __inner: stmt,
  });
  const DB = {
    prepare(sql: string) { return wrap(sqliteDb.prepare(sql), sql); },
    exec(sql: string) { bill(sql); return sqliteDb.exec(sql); },
    batch: (stmts: any[]) => { bill("BATCH"); return sqliteDb.batch(stmts.map((s: any) => s.__inner ?? s)); },
  } as unknown as D1Database;
  return { DB, statements };
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

describe("#347 move batch D1 subrequest budget", () => {
  it("keeps a worst-case batch of 10 not-yet-moved entries inside the free-plan subrequest ceiling", async () => {
    const d1 = makeSqliteD1();
    const { DB, statements } = countingD1(d1.db);
    const kv = makeMemoryKV();
    const env = { ...makeTestEnv(undefined, { DB, VECTORIZE: makeVectorizeMock(), OAUTH_KV: kv }), AUTH_TOKEN: "test-token" } as Env;
    resetDatabaseInit();
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    const helper = makeCtx();

    for (let i = 0; i < 10; i++) {
      await captureEntry(`Budget fixture ${i}`, [], "notion", env, helper.ctx, undefined, {
        workspaceId: roots.ownerPersonalWorkspaceId,
        actorId: roots.ownerUserId,
      });
    }
    await helper.drain();
    const { results } = await env.DB.prepare(`SELECT id FROM entries WHERE source = 'notion' ORDER BY created_at ASC`).all<{ id: string }>();
    expect(results.length).toBe(10);

    const itemMap = Object.fromEntries(results.map((r, i) => [`page-${i}`, { entryId: r.id, version: "v1" }]));
    await kv.put(
      "integrations:notion",
      JSON.stringify({
        provider: "notion", authKind: "token", credentials: { token: "t" }, config: { mirrorWorkspace: "company" },
        status: "connected", workspaceName: "Acme", lastSyncedAt: Date.now(), lastSyncError: null,
        itemMap, createdAt: 0, updatedAt: 0,
      }),
    );

    statements.length = 0; // only the move call's own D1 cost from here
    const moveCall = makeCtx();
    const res = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), env, moveCall.ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.moved).toBe(10);
    await moveCall.drain();

    expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  });
});
