/**
 * #235 §6 — `POST /oauth/revoke-all`, the control that disconnects every AI tool.
 *
 * These go through the real default handler, the same path a request from the
 * Tauri app takes, rather than calling the route function directly. That is what
 * catches a handler that was never registered in `routeHandlers` — the feature
 * would be complete, tested, and unreachable.
 *
 * Two of these tests exist because the naive implementation of a bulk delete is
 * wrong in ways that look fine: it stops after one `list()` page, and it decides
 * what to delete by walking the whole namespace. The first silently leaves half
 * the connections open while reporting success; the second destroys the config,
 * the migration ledger and every integration's credentials.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDefaultHandler } from "../../src/routes/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
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

/**
 * A KV stub that pages the way the real namespace does: `list()` returns at most
 * `pageSize` keys and, when more match, `list_complete: false` plus a cursor to
 * resume after the last key it handed out.
 *
 * The shared `makeMemoryKV` helper always answers `list_complete: true`, so a
 * route that only ever reads the first page passes against it. Deliberately kept
 * local to this file: raising the fidelity of the shared helper would change
 * what every other suite is testing.
 */
function makePagingKV(pageSize: number) {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, String(value));
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (opts: { prefix?: string; limit?: number; cursor?: string } = {}) => {
      const prefix = opts.prefix ?? "";
      // Real cursors are opaque; all that matters is that they resume after a
      // point in the (lexicographically ordered) key space.
      const after = opts.cursor ? atob(opts.cursor) : null;
      const matching = [...store.keys()]
        .filter(k => k.startsWith(prefix))
        .sort()
        .filter(k => after === null || k > after);
      const limit = Math.min(opts.limit ?? pageSize, pageSize);
      const page = matching.slice(0, limit);
      const keys = page.map(name => ({ name }));
      if (page.length < matching.length) {
        return { keys, list_complete: false, cursor: btoa(page[page.length - 1]), cacheStatus: null };
      }
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
  return { kv: kv as unknown as KVNamespace, store };
}

/**
 * A namespace that answers `list()` with *everything*, whatever prefix it was
 * asked for.
 *
 * Both the real KV and `makePagingKV` filter by prefix, which makes the route's
 * own `startsWith` re-check unreachable — and a guard nothing can reach is a
 * comment claiming protection rather than protection. This double is the thing
 * the guard is written against: a scan that comes back wider than it was asked
 * for, whether because the query was widened in a refactor or because the
 * namespace answered loosely. Without the re-check the route deletes the config,
 * the migration ledger and every integration's credentials.
 */
function makeOverReturningKV() {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, String(value));
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    // `prefix` is accepted and deliberately ignored.
    list: async () => ({
      keys: [...store.keys()].sort().map(name => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  };
  return { kv: kv as unknown as KVNamespace, store };
}

describe("oauth revoke-all route", () => {
  let env: Env;
  let store: Map<string, string>;
  let handler: ReturnType<typeof createDefaultHandler>;

  beforeEach(() => {
    // A page size of 2 with more than two keys per family means every test in
    // this file exercises the pagination loop, not only the one that names it.
    const paging = makePagingKV(2);
    store = paging.store;
    env = makeTestEnv(makeTestDb(), { OAUTH_KV: paging.kv, AUTH_TOKEN: TOKEN });
    handler = createDefaultHandler();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /** One grant plus one access token, the shape the provider writes per client. */
  function seedConnection(userId: string, grantId: string) {
    store.set(`grant:${userId}:${grantId}`, JSON.stringify({ clientId: "c" }));
    store.set(`token:${userId}:${grantId}:tok-${grantId}`, JSON.stringify({ grantId, userId }));
  }

  it("refuses without a token", async () => {
    seedConnection("owner", "g1");

    const res = await handler.fetch(req("/oauth/revoke-all", { method: "POST" }, false), env, ctx);

    expect(res.status).toBe(401);
    // An unauthenticated caller must not be able to knock every client off a
    // stranger's brain, so the refusal has to happen before anything is deleted.
    expect(store.has("grant:owner:g1")).toBe(true);
    expect(store.has("token:owner:g1:tok-g1")).toBe(true);
  });

  it("is reachable through the real handler, not just registered in a module", async () => {
    // A handler missing from routeHandlers falls through to the 404 at the end
    // of createDefaultHandler, which is exactly the failure this catches.
    const res = await handler.fetch(req("/oauth/revoke-all", { method: "POST" }), env, ctx);
    expect(res.status).toBe(200);
  });

  it("clears both key families", async () => {
    seedConnection("owner", "g1");

    const res = await handler.fetch(req("/oauth/revoke-all", { method: "POST" }), env, ctx);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.ok).toBe(true);
    // Grants alone are not enough: token validation reads the props out of the
    // `token:` record and never checks that the grant still exists, so a live
    // access token outlives its grant.
    expect([...store.keys()].filter(k => k.startsWith("grant:"))).toEqual([]);
    expect([...store.keys()].filter(k => k.startsWith("token:"))).toEqual([]);
  });

  it("leaves the config, the migration ledger and the integrations untouched", async () => {
    // The data-loss guard. OAUTH_KV is shared with the rest of the Worker; an
    // implementation that walked the namespace instead of the two prefixes would
    // pass every other test here while destroying the user's settings and every
    // connected integration's credentials.
    store.set(CONFIG_KEY, JSON.stringify({ EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5" }));
    store.set(MIGRATION_KEY, JSON.stringify({ model: "x", startedAt: 1 }));
    store.set("integrations:notion", JSON.stringify({ credentials: { token: "secret" } }));
    store.set("integrations:linear", JSON.stringify({ credentials: { token: "secret" } }));
    // Client registrations are an app's identity, not a credential for this
    // brain, and are deliberately kept — see the route's module comment.
    store.set("client:abc", JSON.stringify({ clientId: "abc" }));
    seedConnection("owner", "g1");

    const res = await handler.fetch(req("/oauth/revoke-all", { method: "POST" }), env, ctx);
    expect(res.status).toBe(200);

    expect(store.get(CONFIG_KEY)).toContain("bge-base-en-v1.5");
    expect(store.get(MIGRATION_KEY)).toContain("startedAt");
    expect(store.get("integrations:notion")).toContain("secret");
    expect(store.get("integrations:linear")).toContain("secret");
    expect(store.get("client:abc")).toContain("abc");
    // ...and the connection really was revoked, so this cannot pass by doing
    // nothing at all.
    expect(store.has("grant:owner:g1")).toBe(false);
  });

  it("pages past a single list() page", async () => {
    // Five connections against a page size of two: an implementation that reads
    // one page revokes two of them, reports success, and leaves three clients
    // with working access — the worst outcome a security action can have.
    for (let i = 0; i < 5; i++) seedConnection("owner", `g${i}`);
    expect(store.size).toBe(10);

    const res = await handler.fetch(req("/oauth/revoke-all", { method: "POST" }), env, ctx);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.ok).toBe(true);
    expect(body.revoked).toBe(10);
    expect(store.size).toBe(0);
  });

  it("returns an accurate count", async () => {
    // The count is what the app tells the user, so it has to be the number of
    // keys that actually went away — not the number found, and not a total.
    seedConnection("owner", "g1");
    seedConnection("owner", "g2");
    seedConnection("owner", "g3");
    store.set(CONFIG_KEY, "{}");

    const res = await handler.fetch(req("/oauth/revoke-all", { method: "POST" }), env, ctx);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.revoked).toBe(6);
    expect(body.failed).toBe(0);
  });

  it("reports what it actually deleted when a delete fails", async () => {
    // Deleting a page is not atomic and there is nothing to roll back to, so a
    // partial revocation must not read as a clean one.
    seedConnection("owner", "g1");
    seedConnection("owner", "g2");
    const realDelete = env.OAUTH_KV.delete.bind(env.OAUTH_KV);
    vi.spyOn(env.OAUTH_KV, "delete").mockImplementation(async (key: string) => {
      if (key === "token:owner:g2:tok-g2") throw new Error("KV unavailable");
      return realDelete(key);
    });

    const res = await handler.fetch(req("/oauth/revoke-all", { method: "POST" }), env, ctx);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.revoked).toBe(3);
    expect(body.failed).toBe(1);
  });

  it("deletes by key name even when the scan comes back wider than it asked", async () => {
    // The `startsWith` re-check inside the route is unreachable against KV and
    // against the paging double above, both of which filter by prefix. This is
    // the namespace that makes it fire: it returns the whole store for every
    // list(), so the route's own decision about each key is the only thing
    // standing between a revoke and a wipe.
    const over = makeOverReturningKV();
    const overEnv = makeTestEnv(makeTestDb(), { OAUTH_KV: over.kv, AUTH_TOKEN: TOKEN });
    over.store.set(CONFIG_KEY, JSON.stringify({ EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5" }));
    over.store.set(MIGRATION_KEY, JSON.stringify({ model: "x", startedAt: 1 }));
    over.store.set("integrations:notion", JSON.stringify({ credentials: { token: "secret" } }));
    over.store.set("client:abc", JSON.stringify({ clientId: "abc" }));
    over.store.set("grant:owner:g1", JSON.stringify({ clientId: "c" }));
    over.store.set("token:owner:g1:tok-g1", JSON.stringify({ grantId: "g1" }));

    const res = await handler.fetch(req("/oauth/revoke-all", { method: "POST" }), overEnv, ctx);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    // Exactly the two connection keys, and each counted once even though every
    // list() offered the whole namespace twice over.
    expect(body.revoked).toBe(2);
    expect(over.store.has("grant:owner:g1")).toBe(false);
    expect(over.store.has("token:owner:g1:tok-g1")).toBe(false);
    expect(over.store.get(CONFIG_KEY)).toContain("bge-base-en-v1.5");
    expect(over.store.get(MIGRATION_KEY)).toContain("startedAt");
    expect(over.store.get("integrations:notion")).toContain("secret");
    expect(over.store.get("client:abc")).toContain("abc");
  });

  it("does not revoke on a GET", async () => {
    // A page load, a link preview or a prefetch must never disconnect anything.
    seedConnection("owner", "g1");

    const res = await handler.fetch(req("/oauth/revoke-all"), env, ctx);

    expect(res.status).toBe(404);
    expect(store.has("grant:owner:g1")).toBe(true);
    expect(store.has("token:owner:g1:tok-g1")).toBe(true);
  });
});
