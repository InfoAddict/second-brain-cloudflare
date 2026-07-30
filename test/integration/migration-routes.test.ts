/**
 * #248 — the migration surface the desktop app drives.
 *
 * These go through the real default handler, the same path a request from the
 * Tauri app takes, rather than calling the route functions directly. That is what
 * catches a handler that was never registered in `routeHandlers` — the feature
 * would be complete, tested, and unreachable.
 *
 * The re-embed logic itself is covered in `embedding-migration.test.ts` against
 * real SQLite. This file is about the HTTP contract: auth, shapes, and the fields
 * the app loops on.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDefaultHandler } from "../../src/routes/index";
import { makeMemoryKV, makeTestDb, makeTestEnv } from "../helpers/make-env";
import { CONFIG_KEY } from "../../src/config";
import { MIGRATION_KEY } from "../../src/migration/embedding";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const TOKEN = "test-token";

function req(path: string, init: RequestInit = {}, auth = true) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

describe("migration routes", () => {
  let env: Env;
  let kv: KVNamespace;
  let handler: ReturnType<typeof createDefaultHandler>;

  beforeEach(() => {
    kv = makeMemoryKV();
    env = makeTestEnv(makeTestDb(), { OAUTH_KV: kv, AUTH_TOKEN: TOKEN });
    handler = createDefaultHandler();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /**
   * Every route here reads or rewrites the whole brain's vectors, so an
   * unauthenticated one would let anyone burn a stranger's model budget.
   */
  it("refuses every route without a token", async () => {
    const calls: [string, string][] = [
      ["GET", "/migration/estimate"],
      ["GET", "/migration/status"],
      ["POST", "/migration/reembed"],
      ["POST", "/migration/reset"],
    ];
    for (const [method, path] of calls) {
      const res = await handler.fetch(req(path, { method }, false), env, ctx);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("is reachable through the real handler, not just registered in a module", async () => {
    // A handler missing from routeHandlers falls through to the 404 at the end
    // of createDefaultHandler, which is exactly the failure this catches.
    const res = await handler.fetch(req("/migration/status"), env, ctx);
    expect(res.status).toBe(200);
  });

  it("estimates before anything has been created", async () => {
    const res = await handler.fetch(req("/migration/estimate"), env, ctx);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.entries).toBe("number");
    // Named "at least" because the projection is a lower bound — the chunker's
    // sentence snapping can only produce more.
    expect(typeof body.chunksAtLeast).toBe("number");
    expect(body.model).toBe("@cf/baai/bge-small-en-v1.5");
  });

  it("reports the configured model, so the app can spot a stale ledger", async () => {
    await kv.put(CONFIG_KEY, JSON.stringify({ EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5" }));

    const res = await handler.fetch(req("/migration/status"), env, ctx);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.model).toBe("@cf/baai/bge-base-en-v1.5");
  });

  it("reports no ledger for a brain that has never migrated", async () => {
    const res = await handler.fetch(req("/migration/status"), env, ctx);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBeNull();
  });

  it("returns the fields the app loops on", async () => {
    const res = await handler.fetch(req("/migration/reembed", { method: "POST" }), env, ctx);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    // `remaining` is the field the caller loops until zero — the convention
    // /vectorize-pending and the integration syncs already use.
    for (const field of ["processed", "failed", "remaining", "total", "done", "stalled"]) {
      expect(body, `missing ${field}`).toHaveProperty(field);
    }
  });

  it("forgets the ledger on reset", async () => {
    await kv.put(
      MIGRATION_KEY,
      JSON.stringify({ model: "x", startedAt: 1, cursorCreatedAt: 5, cursorId: "a", processed: 3, failed: 0, totalAtStart: 9 }),
    );
    expect(await kv.get(MIGRATION_KEY)).not.toBeNull();

    const res = await handler.fetch(req("/migration/reset", { method: "POST" }), env, ctx);
    expect(res.status).toBe(200);
    expect(await kv.get(MIGRATION_KEY)).toBeNull();
  });

  it("does not answer the wrong method on a migration path", async () => {
    // A GET that fell through to POST handling would re-embed on a page load.
    const res = await handler.fetch(req("/migration/reembed"), env, ctx);
    expect(res.status).toBe(404);
  });
});
