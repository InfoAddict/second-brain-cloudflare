/**
 * BLOCKER (E2E run 1): the entries_fts sync triggers fire on every write to
 * `entries`, so a missing or broken entries_fts took down capture, MCP
 * remember/append/update/forget, the dashboard, integration mirroring and
 * import with a 500. Real SQLite (not the D1Mock, which cannot evaluate
 * triggers) so a dropped or reshaped entries_fts genuinely fails the way it
 * does against D1.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { makeMirrorStore } from "../../src/integrations/mirror";
import { importExportPayload } from "../../src/entries/import";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { withFtsWriteGuard } from "../../src/db/fts-write-guard";
import { setDbReady } from "../../src/runtime/state";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../../src/constants";
import { OWNER_WRITE_CONTEXT } from "../../src/lib/scope";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

/** entries_fts missing entirely: triggers still reference a table that is gone. */
async function breakByDroppingTable(d1: SqliteD1): Promise<void> {
  await d1.db.exec(`DROP TABLE entries_fts`);
}

/**
 * entries_fts "exists" (sqlite_master reports a table by that name) but is the
 * wrong shape — reproduces the write failing while the corruption check
 * (isFtsFailure) sees a genuine SQLite error naming entries_fts, not a
 * missing-table error. FTS5's own shadow tables (entries_fts_data/_idx/
 * _docsize/_config/_content) refuse direct DML and DROP outright ("table
 * entries_fts_data may not be modified/dropped") even under
 * PRAGMA writable_schema, so they cannot be corrupted directly in node:sqlite.
 * Replacing entries_fts with an ordinary table of the wrong shape is what
 * actually reproduces a live "table exists but is broken" write failure:
 * `INSERT INTO entries_fts (rowid, id, content) ...` then fails with
 * "table entries_fts has no column named id".
 */
async function breakByReshaping(d1: SqliteD1): Promise<void> {
  await d1.db.exec(`DROP TABLE entries_fts`);
  await d1.db.exec(`CREATE TABLE entries_fts (wrong_col TEXT)`);
}

async function ftsObjectNames(d1: SqliteD1): Promise<string[]> {
  const { results } = await d1.db.prepare(
    `SELECT name FROM sqlite_master WHERE name IN ('entries_fts','entries_fts_insert','entries_fts_update','entries_fts_delete')`,
  ).all() as { results: { name: string }[] };
  return results.map(r => r.name).sort();
}

const ALL_FTS_OBJECTS = ["entries_fts", "entries_fts_delete", "entries_fts_insert", "entries_fts_update"];

async function expectRepaired(d1: SqliteD1, env: Env): Promise<void> {
  expect(await ftsObjectNames(d1)).toEqual(ALL_FTS_OBJECTS);
  expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
  expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
}

/**
 * Builds a real-schema env and fully migrates + tenant-bootstraps it while
 * entries_fts is still intact, THEN seeds the ready-flag/cursor state the
 * assertions check. Both steps matter for isolating the write-guard under
 * test from unrelated background repair paths that would otherwise also fix
 * entries_fts (or fail for unrelated reasons) before the test gets to it:
 *
 * - schema.sql's base `entries` table lacks the ALTER-only columns (e.g.
 *   updated_at) that append/update/import read and write, so
 *   initializeDatabase must run once, before the table is broken.
 * - Identity resolution runs ensureTenantBootstrap on first use, which
 *   issues its own multi-statement batch touching `entries` — running it here
 *   (through the SAME write guard instance worker.fetch will reuse, since
 *   withFtsWriteGuard memoizes per raw DB) means the real request under test
 *   hits its memo and never repeats that batch while entries_fts is broken.
 */
async function bootstrapSchema(env: Env): Promise<Env> {
  resetDatabaseInit();
  await initializeDatabase(env);
  const guarded = withFtsWriteGuard(env);
  await ensureTenantBootstrap(guarded);
  return guarded;
}

async function makeEnv(d1: SqliteD1): Promise<Env> {
  const kv = makeMemoryKV();
  const env = makeTestEnv(undefined, {
    DB: d1.db as unknown as D1Database,
    OAUTH_KV: kv,
    VECTORIZE: makeVectorizeMock(),
    AI: makeAIMock(),
  });
  await bootstrapSchema(env);
  // Pre-seeded as if the backfill had already completed, so a passing test
  // proves the repair actually reset them rather than finding them already blank.
  await kv.put(FTS_READY_KV_KEY, "1");
  await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "500");
  return env;
}

describe("a write to entries repairs a missing or broken entries_fts and retries once", () => {
  let d1: SqliteD1;

  beforeEach(() => {
    // Isolate this suite from the unrelated cold-start migration path
    // (ensureDbReady/initializeDatabase): it probes and repairs schema too,
    // in the background, on any request — which would mask the failure this
    // suite exists to reproduce and fix through the write-path guard instead.
    setDbReady(true);
    resetFtsReadyMemo();
  });
  afterEach(() => { d1?.close(); setDbReady(false); });

  describe("missing table", () => {
    it("capture (POST /capture) persists exactly once", async () => {
      d1 = makeSqliteD1();
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/capture", { body: { content: "hello dashboard world" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(1);
      expect(d1.rows()[0].content).toBe("hello dashboard world");
      await expectRepaired(d1, env);
    });

    it("append (POST /append) persists exactly once", async () => {
      d1 = makeSqliteD1();
      d1.seed({ id: "e1", content: "original content", createdAt: 1000 });
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/append", { body: { id: "e1", addition: "more detail" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(1);
      expect(d1.rows()[0].content).toContain("more detail");
      await expectRepaired(d1, env);
    });

    it("update (POST /update) persists exactly once", async () => {
      d1 = makeSqliteD1();
      d1.seed({ id: "e1", content: "stale content", createdAt: 1000 });
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/update", { body: { id: "e1", content: "fresh content" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(1);
      expect(d1.rows()[0].content).toBe("fresh content");
      await expectRepaired(d1, env);
    });

    it("forget (POST /forget) deletes exactly once", async () => {
      d1 = makeSqliteD1();
      d1.seed({ id: "e1", content: "to be forgotten", createdAt: 1000 });
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/forget", { body: { id: "e1" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(0);
      await expectRepaired(d1, env);
    });

    // makeMirrorStore/importExportPayload are called directly rather than
    // through worker.fetch, so they must be handed the SAME guarded env a real
    // request would receive (production reaches them only from inside
    // src/index.ts's fetch/scheduled handlers, both wrapped at the entry
    // point). withFtsWriteGuard is memoized per raw DB, so calling it again
    // here returns the exact instance bootstrapSchema already warmed.
    it("integration mirror create persists exactly once", async () => {
      d1 = makeSqliteD1();
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);

      const id = await makeMirrorStore(withFtsWriteGuard(env)).createEntry("mirrored content", ["source:calendar"], "calendar-google");

      expect(d1.rows()).toHaveLength(1);
      expect(d1.rows()[0].id).toBe(id);
      await expectRepaired(d1, env);
    });

    it("integration mirror update persists exactly once", async () => {
      d1 = makeSqliteD1();
      d1.seed({ id: "e1", content: "mirrored original", createdAt: 1000, source: "calendar-google" });
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);

      const ok = await makeMirrorStore(withFtsWriteGuard(env)).updateEntry("e1", "mirrored updated");

      expect(ok).toBe(true);
      expect(d1.rows()).toHaveLength(1);
      expect(d1.rows()[0].content).toBe("mirrored updated");
      await expectRepaired(d1, env);
    });

    it("import persists exactly once per entry", async () => {
      d1 = makeSqliteD1();
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);

      const summary = await importExportPayload(withFtsWriteGuard(env), {
        entries: [{ id: "imported-1", content: "imported content", tags: [], source: "api", created_at: 1000 }],
      }, { writeCtx: OWNER_WRITE_CONTEXT });

      expect(summary.imported).toBe(1);
      expect(summary.failed).toBe(0);
      expect(d1.rows()).toHaveLength(1);
      await expectRepaired(d1, env);
    });
  });

  // The corrupted-existing-table branch of repairFtsIndex (drop then recreate)
  // only runs on this shape; the missing-table suite above exercises the
  // create-when-absent branch of the same, now-unified, repair path.
  describe("broken (wrong-shaped) table", () => {
    it("capture (POST /capture) persists exactly once", async () => {
      d1 = makeSqliteD1();
      const env = await makeEnv(d1);
      await breakByReshaping(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/capture", { body: { content: "hello again" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(1);
      await expectRepaired(d1, env);
    });

    // forget's DELETE trigger body only references `rowid` (valid on any
    // ordinary rowid table), so a reshaped-but-still-rowid-bearing entries_fts
    // does not fail a delete the way it fails insert/update, which name `id`
    // and `content`. The missing-table describe block above already covers
    // forget against the other corruption shape.
    it("update (POST /update) persists exactly once", async () => {
      d1 = makeSqliteD1();
      d1.seed({ id: "e1", content: "stale content", createdAt: 1000 });
      const env = await makeEnv(d1);
      await breakByReshaping(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/update", { body: { id: "e1", content: "fresh content" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(1);
      expect(d1.rows()[0].content).toBe("fresh content");
      await expectRepaired(d1, env);
    });
  });
});
