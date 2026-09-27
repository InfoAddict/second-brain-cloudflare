/**
 * QA measurement: D1 calls issued by one POST /integrations/notion/disconnect that purges 200
 * mirrored rows. A batch is one call (the sqlite double records it as "BATCH"). The audit share
 * is pinned. Measured 2026-09-26 at 3e978d0: 807 D1 calls in all (4 per purged row: read, read vectors, DELETE entry, DELETE edges), 4 of them audit batches; the per-row loop predates the audit.
 */
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { loadIntegration } from "../../src/integrations";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const auth = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

describe("disconnect purge D1 calls", () => {
  it("200 rows: audit costs 4 batches of 50; total calls are measured", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/users/me")) return new Response(JSON.stringify({ object: "user", type: "bot", name: "SB", bot: { workspace_name: "Acme" } }), { status: 200 });
      return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
    }));
    resetDatabaseInit();
    const sqlite = makeSqliteD1();
    const sizes: number[] = [];
    const db = sqlite.db as any;
    const real = db.batch.bind(db);
    db.batch = (s: unknown[]) => { sizes.push(s.length); return real(s); };
    const env = makeTestEnv(undefined, { DB: db, OAUTH_KV: makeMemoryKV() }) as Env;
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    await worker.fetch(new Request("http://localhost/integrations/notion/connect", { method: "POST", headers: auth, body: JSON.stringify({ token: "t" }) }), env, ctx);
    for (let i = 0; i < 200; i++) {
      sqlite.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '["notion"]', 'notion', 1000, 1000, '[]', ?, ?)`)
        .bind(`p${i}`, `page ${i}`, roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
    }
    const rec = (await loadIntegration(env, "notion"))!;
    rec.itemMap = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, { entryId: `p${i}`, version: "v1" } as any]));
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(rec));

    sqlite.issued.length = 0; sizes.length = 0;
    const res = await worker.fetch(new Request("http://localhost/integrations/notion/disconnect", { method: "POST", headers: auth, body: JSON.stringify({ purge: true }) }), env, ctx);
    expect(((await res.json()) as any).purged).toBe(200);
    const auditInserts = ((await env.DB.prepare(`SELECT COUNT(*) n FROM entry_events WHERE event='deleted'`).first()) as any).n;

    expect(auditInserts).toBe(200);
    // Everything but the audit: 4 calls per row, so the audit adds 4 calls, not 200.
    expect(sqlite.issued.length).toBeLessThan(820);
    expect(sizes.filter(n => n === 50)).toHaveLength(4);
    sqlite.close(); vi.unstubAllGlobals();
  });
});
