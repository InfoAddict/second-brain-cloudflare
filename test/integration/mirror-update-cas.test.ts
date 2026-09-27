/**
 * Adversary reproduction ADV-8 (range bb5377f..5c25183, ported from adv/t1-versions@258a932
 * test/integration/adv-t1-versions.test.ts). makeMirrorStore().updateEntry computed its tags from
 * an earlier read with no compare-and-set, so a user's set_status committed mid-sync was silently
 * overwritten by the sync's own stale-tags write.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { makeMirrorStore } from "../../src/integrations/mirror";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
afterEach(() => sqlite?.close());

const live = async (env: Env, id: string) => (await env.DB.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versions = async (env: Env, id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];

describe("ADV-8: a mirror sync does not revert a concurrent set_status", () => {
  it("the canonical status set during the sync survives it", async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }) as Env;
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    const writeCtx = { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId };

    const ms = makeMirrorStore(env, writeCtx, undefined, "notion");
    const id = await ms.createEntry("page v1", ["notion"], "notion");

    const raw = env.DB as any;
    let raced = false;
    const racingEnv = { ...env, DB: { ...raw, prepare(sql: string) {
      if (!raced && sql.startsWith("INSERT INTO entry_versions")) {
        raced = true;
        raw.prepare(`UPDATE entries SET tags = '["notion","status:canonical"]' WHERE id = ?`).bind(id).run();
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    const racingStore = makeMirrorStore(racingEnv, writeCtx, undefined, "notion");
    const ok = await racingStore.updateEntry(id, "page v2");
    expect(ok).toBe(true);

    const row = await live(env, id);
    expect(JSON.parse(row.tags)).toContain("status:canonical");
    expect(row.content).toBe("page v2");
    // The retry's snapshot recorded the race's tags as the prior state, not the stale first read.
    const vs = await versions(env, id);
    expect(JSON.parse(vs.at(-1)!.tags)).toContain("status:canonical");
  });

  it("an ordinary sync (no race) still costs one batch", async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }) as Env;
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    const writeCtx = { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId };
    const ms = makeMirrorStore(env, writeCtx, undefined, "notion");
    const id = await ms.createEntry("page v1", ["notion"], "notion");

    let batches = 0;
    const raw = env.DB as any;
    const countingEnv = { ...env, DB: { ...raw, batch: (s: unknown[]) => { batches++; return raw.batch(s); } } } as unknown as Env;
    const store = makeMirrorStore(countingEnv, writeCtx, undefined, "notion");
    const ok = await store.updateEntry(id, "page v2");
    expect(ok).toBe(true);
    expect(batches).toBe(1);
  });
});
