/**
 * Mirror deletes and integration purges hard-delete rows, so each writes a
 * `deleted` entry_events row naming why (mirror or disconnect) and the provider.
 * A purge can remove many rows: its trail is ONE env.DB.batch, not one write per row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { loadIntegration } from "../../src/integrations";
import { makeMirrorStore } from "../../src/integrations/mirror";
import type { Env } from "../../src/env";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
const ADMIN = "test-token";

let sqlite: SqliteD1;
let env: Env;
let batches: number[];
let roots: { ownerUserId: string; ownerPersonalWorkspaceId: string };

function stubNotion() {
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("/users/me")) {
      return new Response(JSON.stringify({ object: "user", type: "bot", name: "SB", bot: { workspace_name: "Acme" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
  }));
}

/** Records every batch on the facade in place (a wrapper object would sidestep the FTS write guard). */
function countBatches(db: Env["DB"], into: number[]): Env["DB"] {
  const real = db.batch.bind(db);
  (db as any).batch = (stmts: unknown[]) => { into.push(stmts.length); return real(stmts as any); };
  return db;
}

function seedMirrored(n: number) {
  for (let i = 0; i < n; i++) {
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, '["notion"]', 'notion', 1000, 1000, '[]', ?, ?)`,
    ).bind(`page-${i}`, `Notion page ${i}`, roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
  }
}

async function trail() {
  await Promise.allSettled(pending);
  return ((await env.DB.prepare(`SELECT entry_id, actor_id, event, payload FROM entry_events ORDER BY entry_id`).all()).results) as
    { entry_id: string; actor_id: string; event: string; payload: string }[];
}

beforeEach(async () => {
  resetDatabaseInit();
  pending.length = 0;
  batches = [];
  sqlite = makeSqliteD1();
  const db = sqlite.db as unknown as Env["DB"];
  const counting = countBatches(db, batches);
  env = makeTestEnv(undefined, { DB: counting, OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
  batches.length = 0; // schema setup batches; only the request under test is counted
  stubNotion();
});

afterEach(() => {
  vi.unstubAllGlobals();
  sqlite?.close();
});

describe("mirror delete audit", () => {
  it("writes a deleted event naming the mirror reason and provider", async () => {
    seedMirrored(1);
    const store = makeMirrorStore(env, { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId }, undefined, "notion");
    await store.deleteEntry("page-0");
    // Buffered, not one INSERT per delete inside the sync.
    expect(await trail()).toHaveLength(0);
    await store.flushAudit();
    const rows = await trail();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry_id: "page-0", actor_id: roots.ownerUserId, event: "deleted" });
    expect(JSON.parse(rows[0].payload)).toMatchObject({ reason: "mirror", provider: "notion", channel: "system:mirror" });
  });

  it("writes nothing when the row was already gone", async () => {
    const store = makeMirrorStore(env, undefined, undefined, "notion");
    await store.deleteEntry("missing");
    await store.flushAudit();
    expect(await trail()).toHaveLength(0);
  });

  it("a sync that deletes 120 items writes its trail in batches of at most 50, never one INSERT per delete", async () => {
    seedMirrored(120);
    const store = makeMirrorStore(env, { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId }, undefined, "notion");
    batches.length = 0;
    for (let i = 0; i < 120; i++) await store.deleteEntry(`page-${i}`);
    await store.flushAudit();
    expect(await trail()).toHaveLength(120);
    expect(batches.filter(n => n >= 20)).toEqual([50, 50, 20]);
  });
});

describe("disconnect purge audit", () => {
  async function connectWithItems(n: number) {
    const res = await worker.fetch(new Request("http://localhost/integrations/notion/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ token: "admin-notion-token" }),
    }), env, ctx);
    expect(res.status).toBe(200);
    seedMirrored(n);
    const record = (await loadIntegration(env, "notion"))!;
    record.itemMap = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`k${i}`, { entryId: `page-${i}`, version: "v1" } as any]),
    );
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(record));
  }

  const disconnect = () => worker.fetch(new Request("http://localhost/integrations/notion/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ purge: true }),
  }), env, ctx);

  it("records one deleted event per purged row, naming reason and provider", async () => {
    await connectWithItems(3);
    const body = await (await disconnect()).json() as any;
    expect(body.purged).toBe(3);
    const rows = await trail();
    expect(rows.map(r => r.entry_id)).toEqual(["page-0", "page-1", "page-2"]);
    for (const r of rows) {
      expect(r.event).toBe("deleted");
      expect(r.actor_id).toBe(roots.ownerUserId);
      expect(JSON.parse(r.payload)).toMatchObject({ reason: "disconnect", provider: "notion", channel: "rest" });
    }
  });

  it("the trail costs one batch whether the purge removes 3 rows or 12", async () => {
    await connectWithItems(3);
    await disconnect();
    await trail();
    // Other batches in the request (schema setup) are 2 statements; the audit is the one of 3.
    expect(batches.filter(n => n === 3)).toHaveLength(1);

    // fresh brain, bigger purge
    sqlite.close();
    resetDatabaseInit();
    pending.length = 0;
    batches.length = 0;
    sqlite = makeSqliteD1();
    const db = sqlite.db as unknown as Env["DB"];
    env = makeTestEnv(undefined, {
      DB: countBatches(db, batches),
      OAUTH_KV: makeMemoryKV(),
    });
    await initializeDatabase(env);
    roots = await ensureTenantBootstrap(env);
    batches.length = 0;
    await connectWithItems(12);
    await disconnect();
    await trail();
    expect(batches.filter(n => n === 12)).toHaveLength(1);
  });

  it("a 200-row purge writes its trail in batches of at most 50, one per chunk of deletions", async () => {
    await connectWithItems(200);
    batches.length = 0;
    const body = await (await disconnect()).json() as any;
    expect(body.purged).toBe(200);
    expect(await trail()).toHaveLength(200);
    expect(batches.filter(n => n >= 50)).toEqual([50, 50, 50, 50]);
  });

  it("every deleted row has its event even when the purge dies before the connection is removed", async () => {
    await connectWithItems(60);
    const kv = env.OAUTH_KV as any;
    kv.delete = async () => { throw new Error("KV down"); };
    const res = await disconnect().catch(() => null);
    expect(res === null || res.status >= 500).toBe(true);
    const deleted = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM entries WHERE source = 'notion'`).first()) as { n: number }).n;
    expect(deleted).toBe(0);
    expect(await trail()).toHaveLength(60);
  });

  it("writes no trail for rows a purge skipped or that keep memories", async () => {
    await connectWithItems(2);
    const res = await worker.fetch(new Request("http://localhost/integrations/notion/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({}),
    }), env, ctx);
    expect(res.status).toBe(200);
    expect(await trail()).toHaveLength(0);
  });
});
