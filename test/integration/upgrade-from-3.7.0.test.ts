/**
 * Upgrade path from a 3.7.0-shaped database (Task 11, T-0089.1.1 T-0089.1.2).
 *
 * test/fixtures/schema-3.7.0.sql is db/schema.sql frozen at release commit 0a39810, before
 * tenancy, when_*, recall_count or entry_versions/entries_trash existed. Loading it and then
 * calling initializeDatabase exercises the real upgrade chain (every ALTER since 3.7.0, not just
 * the new tables), which is the only way "no backfill writes" is a fact about production rather
 * than about a hand-trimmed fixture.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeMemoryKV, makeTestEnv, makeAIMock, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, stripSqlComments, splitSchemaStatements, type SqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { updateEntryContent, appendToEntry } from "../../src/capture/store";
import { VERSIONS_SINCE_KV_KEY } from "../../src/constants";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

// A string path, not new URL(...): a duplicate global URL type (DOM lib vs node:url) makes
// readFileSync's URL overload unresolvable under this project's tsconfig. Same convention as
// every other fixture path in test/ (e.g. db-init.test.ts's own schema.sql read).
const FIXTURE = resolve(import.meta.dirname, "../fixtures/schema-3.7.0.sql");

/** The real SqliteD1 facade (batch, queueing, everything Task 1-6's code relies on), started
 * empty and loaded from the frozen 3.7.0 fixture instead of the current db/schema.sql. */
function make370D1(): SqliteD1 & { changes: () => number } {
  const d1 = makeSqliteD1({ schema: false });
  const schema = readFileSync(FIXTURE, "utf8");
  for (const statement of splitSchemaStatements(stripSqlComments(schema))) {
    const sql = statement.trim();
    if (!sql) continue;
    d1.db.exec(sql);
  }
  return d1 as any;
}

let d1: SqliteD1;
let env: Env;
const totalChanges = async () => ((await (d1.db as any).prepare(`SELECT total_changes() AS n`).first()) as any).n as number;

beforeEach(() => {
  resetDatabaseInit();
  d1 = make370D1();
});
afterEach(() => d1.close());

describe("upgrade from a 3.7.0-shaped database", () => {
  it("creates entry_versions, entries_trash and their index, and writes no rows", async () => {
    // A realistic pre-4.0 brain: some rows with a NULL updated_at (never edited since capture).
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES
      ('e1', 'first memory', '["a"]', 'api', 1000, '[]'),
      ('e2', 'second memory', '["b"]', 'claude', 2000, '[]')`);
    const before = await totalChanges();

    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);

    const objects = (await (d1.db as any).prepare(`SELECT name, type FROM sqlite_master WHERE name IN ('entry_versions','entries_trash','idx_entry_versions_entry','idx_entries_trash_deleted')`).all()).results as { name: string; type: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual(["entries_trash", "entry_versions", "idx_entries_trash_deleted", "idx_entry_versions_entry"].sort());
    expect(objects.find((o) => o.name === "entry_versions")!.type).toBe("table");
    expect(objects.find((o) => o.name === "entries_trash")!.type).toBe("table");

    // total_changes() only counts INSERT/UPDATE/DELETE (row writes), never DDL: this is the
    // direct proof that upgrading a 3.7.0 brain to 4.0's schema touches no existing row and
    // inserts none of its own.
    expect((await totalChanges()) - before).toBe(0);

    expect(await env.OAUTH_KV.get(VERSIONS_SINCE_KV_KEY)).not.toBeNull();
  });

  it("a second cold start issues only the probe, no more CREATEs", async () => {
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    resetDatabaseInit();
    d1.issued.length = 0;
    await initializeDatabase(env);
    expect(d1.issued.some((s) => /CREATE TABLE IF NOT EXISTS entry_versions/.test(s))).toBe(false);
    expect(d1.issued.some((s) => /CREATE TABLE IF NOT EXISTS entries_trash/.test(s))).toBe(false);
  });

  it("a pre-4.0 row's first update versions correctly with no gap: seq 1, valid_from = COALESCE(updated_at, created_at)", async () => {
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'I live in Berlin', '["home"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    // Bootstrap assigns legacy rows to the owner's personal workspace (main tenancy.ts:127); a
    // one-time backfill of workspace_id/actor_id is out of scope for Task 11 (design row 23), so
    // it is not asserted against here.
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const r = await updateEntryContent(env, "e1", "I live in Munich now", DEFAULTS, undefined, undefined, { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId }, change, roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("updated");

    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].content).toBe("I live in Berlin");
    // updated_at was NULL on this legacy row, so valid_from falls back to created_at (P13 / design "valid_from").
    expect(versions[0].valid_from).toBe(1000);
  });

  it("a pre-4.0 row's first append versions correctly and reconstructs the prior text", async () => {
    d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'Notes:', '["work"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const ok = await appendToEntry(env, "e1", "Notes:", "met Sam", [], "api", DEFAULTS, undefined, { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId }, change, undefined, roots.ownerPersonalWorkspaceId);
    expect(ok).toBe(true);

    const row = await (d1.db as any).prepare(`SELECT content FROM entries WHERE id = 'e1'`).first();
    expect(row.content).toContain("Notes:");
    expect(row.content).toContain("met Sam");
    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].valid_from).toBe(1000);
  });
});
