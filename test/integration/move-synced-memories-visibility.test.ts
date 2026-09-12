/**
 * #347's headline acceptance criterion: a move is proven by VISIBILITY, not by
 * reading the entries.workspace_id column directly. This drives real requests
 * as a second team member, through GET /recall, exactly the surface the
 * feature exists to fix — before the move Bob cannot find a memory that lives
 * in the owner's personal workspace; after the move into the company layer, he
 * can, through the same scoped query, with nothing about his own identity or
 * request changed.
 *
 * Route contract exercised here: POST /integrations/:provider/move — see
 * move-synced-memories.test.ts's header comment for the full shape.
 */
import { describe, it, expect } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import type { D1Mock } from "../helpers/d1-mock";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { captureEntry } from "../../src/capture/entry";
import type { Env } from "../../src/env";

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

async function makeEnv() {
  const d1 = makeSqliteD1();
  const env = { ...makeTestEnv(d1.db as unknown as D1Mock, { VECTORIZE: makeVectorizeMock(), OAUTH_KV: makeMemoryKV() }), AUTH_TOKEN: "test-token" } as Env;
  resetDatabaseInit();
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  return { env, roots };
}

// A word unlikely to appear anywhere else recall's keyword search will scan
// against — the fixture data in this file and nowhere else.
const MARKER = "zylophantine";

describe("#347 scoped recall visibility across a move", () => {
  it("a second team member's scoped recall finds a moved memory afterwards and did not before", async () => {
    const { env, roots } = await makeEnv();
    const helper = makeCtx();
    const bob = await createMember(env, { name: "Bob" });

    await captureEntry(`Notes about ${MARKER} deployment procedures for the roadmap`, [], "notion", env, helper.ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    await helper.drain();
    const { id } = await env.DB.prepare(`SELECT id FROM entries WHERE source = 'notion' LIMIT 1`).first<{ id: string }>() ?? {};
    expect(id).toBeTruthy();

    // Before the move: Bob's own scoped recall must not surface Alice's
    // private mirror, exactly like any other private memory.
    const before = await worker.fetch(req("GET", `/recall?query=${MARKER}`, { token: bob.token }), env, makeCtx().ctx);
    expect(before.status).toBe(200);
    const beforeData = await before.json() as any;
    const beforeIds = (beforeData.results ?? []).map((r: any) => r.id);
    expect(beforeIds).not.toContain(id);

    // Connect the integration at the company layer, with this entry already
    // mirrored, and drive the move.
    await env.OAUTH_KV.put(
      "integrations:notion",
      JSON.stringify({
        provider: "notion", authKind: "token", credentials: { token: "t" }, config: { mirrorWorkspace: "company" },
        status: "connected", workspaceName: "Acme", lastSyncedAt: Date.now(), lastSyncError: null,
        itemMap: { "page-0": { entryId: id, version: "v1" } }, createdAt: 0, updatedAt: 0,
      }),
    );
    const moveCall = makeCtx();
    const moveRes = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), env, moveCall.ctx);
    expect(moveRes.status).toBe(200);
    const moveData = await moveRes.json() as any;
    expect(moveData.moved).toBe(1);
    await moveCall.drain();

    // Same query, same identity, nothing about Bob's request changed — now it
    // finds the entry, through the company layer.
    const after = await worker.fetch(req("GET", `/recall?query=${MARKER}`, { token: bob.token }), env, makeCtx().ctx);
    expect(after.status).toBe(200);
    const afterData = await after.json() as any;
    const afterIds = (afterData.results ?? []).map((r: any) => r.id);
    expect(afterIds).toContain(id);
    const afterRow = afterData.results.find((r: any) => r.id === id);
    expect(afterRow.workspace).toBe("company");
  });

  it("GET /list shows the moved memory to a second team member afterwards and did not before, same as recall", async () => {
    const { env, roots } = await makeEnv();
    const helper = makeCtx();
    const bob = await createMember(env, { name: "Bob" });

    await captureEntry("Second fixture entry, unrelated content", [], "notion", env, helper.ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    await helper.drain();
    const { id } = await env.DB.prepare(`SELECT id FROM entries WHERE source = 'notion' LIMIT 1`).first<{ id: string }>() ?? {};

    const beforeList = await worker.fetch(req("GET", "/list?n=50", { token: bob.token }), env, makeCtx().ctx);
    const beforeRows = await beforeList.json() as any[];
    expect(beforeRows.map((r) => r.id)).not.toContain(id);

    await env.OAUTH_KV.put(
      "integrations:notion",
      JSON.stringify({
        provider: "notion", authKind: "token", credentials: { token: "t" }, config: { mirrorWorkspace: "company" },
        status: "connected", workspaceName: "Acme", lastSyncedAt: Date.now(), lastSyncError: null,
        itemMap: { "page-0": { entryId: id, version: "v1" } }, createdAt: 0, updatedAt: 0,
      }),
    );
    const moveRes = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), env, makeCtx().ctx);
    expect(moveRes.status).toBe(200);
    expect(((await moveRes.json()) as any).moved).toBe(1);

    const afterList = await worker.fetch(req("GET", "/list?n=50", { token: bob.token }), env, makeCtx().ctx);
    const afterRows = await afterList.json() as any[];
    expect(afterRows.map((r) => r.id)).toContain(id);
  });
});
