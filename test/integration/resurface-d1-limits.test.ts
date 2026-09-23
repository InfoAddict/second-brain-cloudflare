/**
 * Resurface v2's pick query (src/routes/brief.ts's pickResurface) binds its
 * filter + topic + exclusion + scope clause TWICE — once for the row, once
 * for the OFFSET subquery it wraps against. scope.bindings is not a small
 * constant: it is personal plus every company workspace the caller belongs
 * to (readableWorkspaces, src/lib/scope.ts), unbounded in principle and ~32
 * real teams for an admin today (see the /stats/graph comment in admin.ts
 * making the same point). A fixed topic (6) and exclusion (20) allowance
 * alongside a wide enough scope pushed that doubled statement past D1's
 * 100-bound-parameter ceiling — and pickResurface had no try/catch, so the
 * overflow 500'd the WHOLE GET /brief response, not just the resurface field.
 *
 * Driven against real SQLite with a facade that enforces D1's real limit
 * (test/integration/recall-d1-limits.test.ts's approach), so a query that
 * would 500 in production fails the test here instead of silently passing
 * against a mock that never evaluates bound-parameter counts.
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resurfaceStateKey } from "../../src/runtime/resurface-state";
import { setDbReady } from "../../src/runtime/state";
import type { Env } from "../../src/env";

const D1_MAX_BOUND_PARAMS = 100;
const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

interface Executed { sql: string; params: unknown[] }

/** Enforces D1's real bound-parameter ceiling and records every statement run. */
function withD1Limits(inner: SqliteD1["db"], executed: Executed[]) {
  const check = (sql: string, params: unknown[]) => {
    executed.push({ sql, params });
    if (params.length > D1_MAX_BOUND_PARAMS) {
      throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
    }
  };
  const wrap = (sql: string, stmt: any, params: unknown[]): any => ({
    bind: (...args: unknown[]) => wrap(sql, stmt.bind(...args), args),
    all: async () => { check(sql, params); return stmt.all(); },
    first: async () => { check(sql, params); return stmt.first(); },
    run: async () => { check(sql, params); return stmt.run(); },
  });
  return {
    prepare: (sql: string) => wrap(sql, inner.prepare(sql), []),
    exec: (sql: string) => inner.exec(sql),
    // Identity resolution and the tenant bootstrap batch writes through here.
    batch: (stmts: any[]) => inner.batch(stmts),
  };
}

/** Directly inserts N company workspaces + memberships for `userId` — the subject here is scope.bindings.length, not the team-admin flow that would normally grow it. */
function addCompanyWorkspaces(sqlite: SqliteD1, userId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const wsId = `ws-company-${i}`;
    sqlite.db.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', ?, ?)`)
      .bind(wsId, `Team ${i}`, 1000 + i).run();
    sqlite.db.prepare(`INSERT INTO memberships (user_id, workspace_id, role, created_at) VALUES (?, ?, 'member', ?)`)
      .bind(userId, wsId, 1000 + i).run();
  }
}

const pickQueriesOf = (executed: Executed[]) => executed.filter(e => e.sql.includes("OFFSET (?"));

let sqlite: SqliteD1 | null = null;
afterEach(() => { sqlite?.close(); sqlite = null; setDbReady(false); });

describe("resurface v2 stays inside D1's bound-parameter limit", () => {
  it("never overflows for a member of many company workspaces, with full topic preference and exclusions", async () => {
    sqlite = makeSqliteD1();
    resetDatabaseInit();
    const executed: Executed[] = [];
    const limitedDb = withD1Limits(sqlite.db, executed);
    const bootstrapEnv = makeTestEnv(limitedDb as any);

    await initializeDatabase(bootstrapEnv);
    setDbReady(true);
    const roots = await ensureTenantBootstrap(bootstrapEnv);
    // 40 more company workspaces on top of the one ensureTenantBootstrap
    // already made: scope.bindings.length lands around personal(1) +
    // company(41) + the admin's legacy ''(1) = 43.
    addCompanyWorkspaces(sqlite, roots.ownerUserId, 40);

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // Six distinct topic tags this week, so the topic-preference branch (the
    // thing that adds extra bindings on top of scope) is actually exercised.
    for (let i = 0; i < 6; i++) {
      sqlite.seed({ id: `recent-${i}`, content: `Work on topic ${i}`, createdAt: now - 1000 - i, tags: [`topic${i}`] });
    }
    // 25 resurface candidates sharing one of those topics, so the preferred
    // pool is non-empty and the pick query actually runs against it.
    for (let i = 0; i < 25; i++) {
      sqlite.seed({
        id: `cand-${i}`, content: `Old decision about topic${i % 6}`,
        createdAt: now - 200 * DAY - i, importanceScore: 5, tags: [`topic${i % 6}`],
      });
    }
    // A full exclusion list: 20 dismissed ids, so the desired exclusion count
    // (RESURFACE_EXCLUDE_BOUND_CAP) is also at its target going in.
    const kv = makeMemoryKV();
    await kv.put(
      resurfaceStateKey(roots.ownerPersonalWorkspaceId),
      JSON.stringify({
        day: -1, shownId: null, recent: [],
        dismissed: Array.from({ length: 20 }, (_, i) => `dismissed-${i}`),
      }),
    );

    const env = makeTestEnv(limitedDb as any, { OAUTH_KV: kv });

    const res = await worker.fetch(req("GET", "/brief"), env, ctx);

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    // The point isn't which candidate wins — a wide-enough scope may have
    // dropped topic preference or trimmed exclusions to fit — only that the
    // endpoint answers at all rather than 500ing on every field alongside it.
    expect(data.resurface === null || typeof data.resurface?.id === "string").toBe(true);

    const pickQueries = pickQueriesOf(executed);
    expect(pickQueries.length).toBeGreaterThan(0);
    for (const q of pickQueries) {
      expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    }
  });
});
