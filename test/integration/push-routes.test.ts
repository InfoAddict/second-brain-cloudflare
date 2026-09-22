/**
 * The Web Push HTTP surface (src/routes/push.ts): vapid-public-key,
 * subscribe/unsubscribe, and the admin run/test triggers. Real SQLite so the
 * ON CONFLICT upsert and the scoped delete are checked as real SQL.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); vi.restoreAllMocks(); });

function dbOf(s: SqliteD1) {
  return { prepare: (sql: string) => s.db.prepare(sql), exec: (sql: string) => s.db.exec(sql), batch: (stmts: any[]) => s.db.batch(stmts) };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  setDbReady(true);
  return s;
}

const envOf = (s: SqliteD1) => makeTestEnv(dbOf(s) as any, { OAUTH_KV: makeMemoryKV() });

const VALID_SUBSCRIPTION = {
  endpoint: "https://push.example.com/s1",
  keys: {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  },
};

describe("GET /push/vapid-public-key", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("GET", "/push/vapid-public-key", { token: null }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("returns a base64url public key", async () => {
    sq = await migrated();
    const data = await (await worker.fetch(req("GET", "/push/vapid-public-key"), envOf(sq), ctx)).json() as any;
    expect(data.ok).toBe(true);
    expect(typeof data.publicKey).toBe("string");
    expect(data.publicKey.length).toBeGreaterThan(0);
  });
});

describe("POST /push/subscribe", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/push/subscribe", { token: null, body: { subscription: VALID_SUBSCRIPTION } }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("rejects a malformed subscription", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/push/subscribe", { body: { subscription: { endpoint: "https://x" } } }), envOf(sq), ctx);
    expect(res.status).toBe(400);
  });

  it("stores a new subscription", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/push/subscribe", { body: { subscription: VALID_SUBSCRIPTION } }), envOf(sq), ctx);
    expect((await res.json() as any).ok).toBe(true);

    const row = (await sq.db.prepare(`SELECT content_free FROM push_subscriptions`).first()) as any;
    expect(row.content_free).toBe(0);
  });

  it("stores content_free when requested", async () => {
    sq = await migrated();
    await worker.fetch(req("POST", "/push/subscribe", { body: { subscription: VALID_SUBSCRIPTION, content_free: true } }), envOf(sq), ctx);

    const row = (await sq.db.prepare(`SELECT content_free FROM push_subscriptions`).first()) as any;
    expect(row.content_free).toBe(1);
  });

  it("records this deployment's own origin, later used as the VAPID JWT's default sub", async () => {
    sq = await migrated();
    const kv = makeMemoryKV();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });

    await worker.fetch(req("POST", "/push/subscribe", { body: { subscription: VALID_SUBSCRIPTION } }), env, ctx);

    expect(await kv.get("push:origin")).toBe("http://localhost");
  });

  it("re-subscribing the same endpoint replaces rather than duplicates", async () => {
    sq = await migrated();
    await worker.fetch(req("POST", "/push/subscribe", { body: { subscription: VALID_SUBSCRIPTION } }), envOf(sq), ctx);
    await worker.fetch(req("POST", "/push/subscribe", { body: { subscription: VALID_SUBSCRIPTION, content_free: true } }), envOf(sq), ctx);

    const rows = (await sq.db.prepare(`SELECT content_free FROM push_subscriptions`).all()).results as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].content_free).toBe(1);
  });
});

describe("POST /push/unsubscribe", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/push/unsubscribe", { token: null, body: { endpoint: "x" } }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("requires an endpoint", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/push/unsubscribe", { body: {} }), envOf(sq), ctx);
    expect(res.status).toBe(400);
  });

  it("removes the subscription", async () => {
    sq = await migrated();
    await worker.fetch(req("POST", "/push/subscribe", { body: { subscription: VALID_SUBSCRIPTION } }), envOf(sq), ctx);

    const res = await worker.fetch(req("POST", "/push/unsubscribe", { body: { endpoint: VALID_SUBSCRIPTION.endpoint } }), envOf(sq), ctx);
    expect((await res.json() as any).ok).toBe(true);

    const rows = (await sq.db.prepare(`SELECT id FROM push_subscriptions`).all()).results as any[];
    expect(rows).toHaveLength(0);
  });

  it("is a no-op for an endpoint that was never subscribed", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/push/unsubscribe", { body: { endpoint: "https://never.example.com" } }), envOf(sq), ctx);
    expect(res.status).toBe(200);
  });
});

describe("POST /push/run", () => {
  it("requires admin", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/push/run", { token: null }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("reports zero when there is nothing due", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/push/run"), envOf(sq), ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.sent).toBe(0);
  });

  it("sends to a real due item once subscribed", async () => {
    sq = await migrated();
    sq.seed({ id: "e1", content: "File the report", createdAt: 1000 });
    sq.db.prepare(`UPDATE entries SET when_at = ? WHERE id = 'e1'`).bind(Date.now() - 1000).run();
    await worker.fetch(req("POST", "/push/subscribe", { body: { subscription: VALID_SUBSCRIPTION } }), envOf(sq), ctx);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    const res = await worker.fetch(req("POST", "/push/run"), envOf(sq), ctx);
    const data = await res.json() as any;
    expect(data.sent).toBe(1);
  });

  it("reports per-subscription outcomes for live diagnosis", async () => {
    sq = await migrated();
    sq.seed({ id: "e1", content: "File the report", createdAt: 1000 });
    sq.db.prepare(`UPDATE entries SET when_at = ? WHERE id = 'e1'`).bind(Date.now() - 1000).run();
    await worker.fetch(req("POST", "/push/subscribe", { body: { subscription: VALID_SUBSCRIPTION } }), envOf(sq), ctx);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    const res = await worker.fetch(req("POST", "/push/run"), envOf(sq), ctx);
    const data = await res.json() as any;

    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results.length).toBeLessThanOrEqual(10);
    expect(data.results[0]).toMatchObject({ status: "ok" });
    expect(typeof data.results[0].endpoint_hash_prefix).toBe("string");
  });
});

describe("POST /push/test", () => {
  it("requires admin", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/push/test", { token: null }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("sends a fixed notification with no due items required", async () => {
    sq = await migrated();
    await worker.fetch(req("POST", "/push/subscribe", { body: { subscription: VALID_SUBSCRIPTION } }), envOf(sq), ctx);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    const res = await worker.fetch(req("POST", "/push/test"), envOf(sq), ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.sent).toBe(1);
  });

  it("reports per-subscription outcomes, same shape as POST /push/run — this bug hid behind a bare count", async () => {
    sq = await migrated();
    await worker.fetch(req("POST", "/push/subscribe", { body: { subscription: VALID_SUBSCRIPTION } }), envOf(sq), ctx);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));

    const res = await worker.fetch(req("POST", "/push/test"), envOf(sq), ctx);
    const data = await res.json() as any;

    expect(data.sent).toBe(0);
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results[0]).toMatchObject({ status: "http_403" });
  });
});
