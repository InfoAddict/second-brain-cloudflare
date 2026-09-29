/**
 * FX3 finding 4 (MINOR): pushDueItemsAllWorkspaces (the hourly cron) writes one delivery
 * record per workspace it reserves into, plus the lease and the cursor — up to 42 KV writes an
 * hour, every hour, forever: ~1,008/day with nothing slowing it down, alone close to a shared
 * account-wide daily KV write quota other subsystems (the standing cache, nightly cleanup) also
 * need a share of. There was no cap of push's own before this — MAX_PUSH_KV_WRITES_PER_DAY is one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { pushDueItemsAllWorkspaces, MAX_PUSH_KV_WRITES_PER_DAY, PUSH_KV_WRITE_COUNT_KEY } from "../../src/push/send";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; resetDatabaseInit(); vi.restoreAllMocks(); });

function dbOf(s: SqliteD1) {
  return { prepare: (sql: string) => s.db.prepare(sql), exec: (sql: string) => s.db.exec(sql), batch: (stmts: any[]) => s.db.batch(stmts) };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  return s;
}

const VALID_P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const VALID_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

function seedDue(s: SqliteD1, id: string, whenAt: number, workspaceId: string) {
  s.seed({ id, content: `Item ${id}`, createdAt: 1000, tags: [] });
  s.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'model', when_label = ?, workspace_id = ? WHERE id = ?`)
    .bind(whenAt, `Item ${id}`, workspaceId, id).run();
}

function seedSubscription(s: SqliteD1, id: string, workspaceId: string) {
  s.db.prepare(
    `INSERT INTO push_subscriptions (id, workspace_id, endpoint_hash, subscription_json, content_free, created_at, fail_count)
     VALUES (?, ?, ?, ?, 0, ?, 0)`,
  ).bind(
    id, workspaceId, `hash-${id}`,
    JSON.stringify({ endpoint: `https://push.example.com/${id}`, keys: { p256dh: VALID_P256DH, auth: VALID_AUTH } }),
    Date.now(),
  ).run();
}

describe("pushDueItemsAllWorkspaces respects a self-imposed daily KV write cap", () => {
  it("sends nothing and reports daily_kv_cap once today's count is already at the cap, making no delivery-record write", async () => {
    sq = await migrated();
    seedDue(sq, "e1", Date.now() - 1000, "ws-a");
    seedSubscription(sq, "s1", "ws-a");
    const kv = makeMemoryKV();
    const today = new Date().toISOString().slice(0, 10);
    await kv.put(PUSH_KV_WRITE_COUNT_KEY, JSON.stringify({ date: today, count: MAX_PUSH_KV_WRITES_PER_DAY }));
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    const putSpy = vi.spyOn(kv, "put");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 201 })));

    const result = await pushDueItemsAllWorkspaces(env);

    expect(result).toEqual({ sent: 0, skipped: "daily_kv_cap" });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("still sends when today's count is comfortably under the cap, and advances the count by exactly what it wrote", async () => {
    sq = await migrated();
    seedDue(sq, "e1", Date.now() - 1000, "ws-a");
    seedSubscription(sq, "s1", "ws-a");
    const kv = makeMemoryKV();
    const today = new Date().toISOString().slice(0, 10);
    await kv.put(PUSH_KV_WRITE_COUNT_KEY, JSON.stringify({ date: today, count: MAX_PUSH_KV_WRITES_PER_DAY - 5 }));
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 201 })));

    const result = await pushDueItemsAllWorkspaces(env);

    expect(result.skipped).toBeUndefined();
    expect(result.sent).toBe(1);
    // One delivery-record write (ws-a) plus the cursor write.
    const stored = JSON.parse((await kv.get(PUSH_KV_WRITE_COUNT_KEY))!) as { date: string; count: number };
    expect(stored.date).toBe(today);
    expect(stored.count).toBe(MAX_PUSH_KV_WRITES_PER_DAY - 5 + 2);
  });

  it("resets the cap at UTC midnight: a stale count from a prior day does not block today's run", async () => {
    sq = await migrated();
    seedDue(sq, "e1", Date.now() - 1000, "ws-a");
    seedSubscription(sq, "s1", "ws-a");
    const kv = makeMemoryKV();
    await kv.put(PUSH_KV_WRITE_COUNT_KEY, JSON.stringify({ date: "2000-01-01", count: MAX_PUSH_KV_WRITES_PER_DAY }));
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 201 })));

    const result = await pushDueItemsAllWorkspaces(env);

    expect(result.skipped).toBeUndefined();
    expect(result.sent).toBe(1);
  });
});
