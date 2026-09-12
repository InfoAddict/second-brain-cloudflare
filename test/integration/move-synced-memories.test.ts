/**
 * Acceptance tests for issue #347 — moving already-synced integration memories
 * into the connection's current layer.
 *
 * Route contract exercised here (not yet implemented; this file is Wave 1 and
 * intentionally red): `POST /integrations/:provider/move`, admin-gated at the
 * edge like connect/sync/disconnect/layer, then narrowed to "caller must BE
 * the tenant owner" inside the handler (docs/superpowers/plans/2026-09-12-347-plan.md,
 * locked decision 1). Body: `{ cursor?: string }`. Response on success:
 * `{ ok: true, provider, target, moved, alreadyThere, missing, refused, remaining, cursor }`
 * where `cursor` is the external item-map key to resume after, `null` when the
 * whole map has been walked. Batch size is 10 (locked decision 5), iterating
 * `Object.keys(itemMap).sort()` (locked decision 6).
 *
 * These names are picked by this test file because the plan does not pin a
 * route path or a cursor shape — see the test-author's final report for the
 * full list of choices made here for the implementer to match.
 */
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import type { D1Mock } from "../helpers/d1-mock";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap, type TenantRoots } from "../../src/lib/tenancy";
import { captureEntry } from "../../src/capture/entry";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

/** A Vectorize double that actually remembers what was upserted, like share-vector-restamp.test.ts's. */
function makeStatefulVectorizeMock() {
  const store = new Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>();
  const upsert = vi.fn(async (vectors: { id: string; values: number[]; metadata: Record<string, unknown> }[]) => {
    for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: { ...v.metadata } });
    return { mutationId: "m" };
  });
  const getByIds = vi.fn(async (ids: string[]) => ids.map(id => store.get(id)).filter((v): v is NonNullable<typeof v> => !!v));
  const vectorize = makeVectorizeMock({ upsert: upsert as never, getByIds: getByIds as never });
  return { vectorize, upsert, getByIds, store };
}

/** Same shape, but getByIds blocks on a gate until the test releases it — for
 * proving the route AWAITS the re-stamp rather than deferring it (locked
 * decision 4), instead of trusting timing coincidence. */
function makeGatedVectorizeMock() {
  const store = new Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const upsert = vi.fn(async (vectors: { id: string; values: number[]; metadata: Record<string, unknown> }[]) => {
    for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: { ...v.metadata } });
    return { mutationId: "m" };
  });
  const getByIds = vi.fn(async (ids: string[]) => {
    await gate;
    return ids.map(id => store.get(id)).filter((v): v is NonNullable<typeof v> => !!v);
  });
  const vectorize = makeVectorizeMock({ upsert: upsert as never, getByIds: getByIds as never });
  return { vectorize, upsert, getByIds, store, release: () => release() };
}

async function makeEnv(vectorize: ReturnType<typeof makeVectorizeMock>) {
  const d1 = makeSqliteD1();
  const env = { ...makeTestEnv(d1.db as unknown as D1Mock, { VECTORIZE: vectorize, OAUTH_KV: makeMemoryKV() }), AUTH_TOKEN: "test-token" } as Env;
  resetDatabaseInit();
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  return { env, roots };
}

/** Mirrors N entries into the owner's personal workspace, as a real sync would. */
async function seedMirrored(
  env: Env,
  roots: TenantRoots,
  helper: { ctx: ExecutionContext; drain: () => Promise<unknown> },
  n: number,
  labelPrefix = "mirrored",
): Promise<string[]> {
  for (let i = 0; i < n; i++) {
    await captureEntry(`${labelPrefix} page ${i}: distinctive content ${labelPrefix}-${i}`, [], "notion", env, helper.ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
  }
  await helper.drain();
  const { results } = await env.DB.prepare(
    `SELECT id FROM entries WHERE source = 'notion' ORDER BY created_at ASC, id ASC`,
  ).all<{ id: string }>();
  return results.map((r) => r.id);
}

function itemMapFor(ids: string[], keyPrefix = "page"): Record<string, { entryId: string; version: string }> {
  return Object.fromEntries(ids.map((id, i) => [`${keyPrefix}-${String(i).padStart(3, "0")}`, { entryId: id, version: "v1" }]));
}

async function connectNotion(
  env: Env,
  itemMap: Record<string, { entryId: string; version: string }>,
  mirrorWorkspace: "personal" | "company" = "company",
) {
  await env.OAUTH_KV.put(
    "integrations:notion",
    JSON.stringify({
      provider: "notion",
      authKind: "token",
      credentials: { token: "notion-secret" },
      config: { mirrorWorkspace },
      status: "connected",
      workspaceName: "Acme Notion",
      lastSyncedAt: Date.now(),
      lastSyncError: null,
      itemMap,
      createdAt: 0,
      updatedAt: 0,
    }),
  );
}

function moveRequest(cursor?: string, token?: string) {
  return req("POST", "/integrations/notion/move", { body: cursor ? { cursor } : {}, ...(token ? { token } : {}) });
}

describe("#347 move already-synced integration memories", () => {
  it("moves 3 mirrored entries personal to company: ids unchanged, content unchanged, actor unchanged, edges follow, vectors re-stamped", async () => {
    const { vectorize, upsert, getByIds } = makeStatefulVectorizeMock();
    const { env, roots } = await makeEnv(vectorize);
    const helper = makeCtx();
    const ids = await seedMirrored(env, roots, helper, 3);

    // An edge between two of the mirrored entries, denormalized into the
    // owner's personal workspace at creation, same as graph/edges.ts does.
    await env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES (?, ?, ?, 'related', 0.5, 'test', '{}', ?, ?, ?)`,
    ).bind("edge-347-1", ids[0], ids[1], Date.now(), Date.now(), roots.ownerPersonalWorkspaceId).run();

    const originalContents = new Map<string, string>();
    for (const id of ids) {
      const row = await env.DB.prepare(`SELECT content FROM entries WHERE id = ?`).bind(id).first<{ content: string }>();
      originalContents.set(id, row!.content);
    }

    await connectNotion(env, itemMapFor(ids), "company");

    const moveCall = makeCtx();
    const res = await worker.fetch(moveRequest(), env, moveCall.ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.moved).toBe(3);
    expect(data.alreadyThere).toBe(0);
    expect(data.missing).toBe(0);
    expect(data.refused).toBe(0);
    expect(data.remaining).toBe(0);
    await moveCall.drain();

    for (const id of ids) {
      const row = await env.DB.prepare(`SELECT id, workspace_id, actor_id, content FROM entries WHERE id = ?`).bind(id).first<any>();
      expect(row.id).toBe(id); // id preserved, not recreated
      expect(row.workspace_id).toBe(roots.companyWorkspaceId); // moved
      expect(row.actor_id).toBe(roots.ownerUserId); // authorship untouched
      expect(row.content).toBe(originalContents.get(id)); // content untouched
    }

    const { results: edgeRows } = await env.DB.prepare(
      `SELECT workspace_id FROM edges WHERE source_id = ? OR target_id = ?`,
    ).bind(ids[0], ids[0]).all<{ workspace_id: string }>();
    expect(edgeRows.length).toBeGreaterThan(0);
    for (const e of edgeRows) expect(e.workspace_id).toBe(roots.companyWorkspaceId);

    // Vectors actually re-stamped, not just the D1 column — the round trip
    // (getByIds then upsert with mutated metadata) that share-vector-restamp
    // pins for /share.
    expect(getByIds).toHaveBeenCalled();
    const anyRestamped = upsert.mock.calls.some((call) =>
      (call[0] as any[]).some((v) => v.metadata?.workspace_id === roots.companyWorkspaceId),
    );
    expect(anyRestamped).toBe(true);
  });

  it("awaits the vector re-stamp before responding, rather than deferring it into waitUntil", async () => {
    const { vectorize, store, release } = makeGatedVectorizeMock();
    const { env, roots } = await makeEnv(vectorize);
    const helper = makeCtx();
    const ids = await seedMirrored(env, roots, helper, 1);
    // Seed the vector store directly with whatever vector id capture produced,
    // so restampVectorWorkspace's getByIds has something to gate on.
    const { vector_ids } = await env.DB.prepare(`SELECT vector_ids FROM entries WHERE id = ?`).bind(ids[0]).first<{ vector_ids: string }>() ?? { vector_ids: "[]" };
    for (const vid of JSON.parse(vector_ids || "[]")) {
      store.set(vid, { id: vid, values: [0.1], metadata: { workspace_id: roots.ownerPersonalWorkspaceId } });
    }
    await connectNotion(env, itemMapFor(ids), "company");

    const moveCall = makeCtx();
    let settled = false;
    const movePromise = worker.fetch(moveRequest(), env, moveCall.ctx).then((r) => { settled = true; return r; });

    // Let every microtask that doesn't need the gate run.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(settled, "the response resolved before the vector re-stamp finished — it must be awaited, not deferred").toBe(false);

    release();
    const res = await movePromise;
    expect(res.status).toBe(200);
    expect(settled).toBe(true);
  });

  it("re-running over an already-moved set reports alreadyThere and changes nothing (idempotent resume)", async () => {
    const { vectorize } = makeStatefulVectorizeMock();
    const { env, roots } = await makeEnv(vectorize);
    const helper = makeCtx();
    const ids = await seedMirrored(env, roots, helper, 2);
    await connectNotion(env, itemMapFor(ids), "company");

    const first = await worker.fetch(moveRequest(), env, makeCtx().ctx);
    expect(first.status).toBe(200);
    const firstData = await first.json() as any;
    expect(firstData.moved).toBe(2);

    const second = await worker.fetch(moveRequest(), env, makeCtx().ctx);
    expect(second.status).toBe(200);
    const secondData = await second.json() as any;
    expect(secondData.moved).toBe(0);
    expect(secondData.alreadyThere).toBe(2);
    expect(secondData.missing).toBe(0);
    expect(secondData.refused).toBe(0);

    for (const id of ids) {
      const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id).first<{ workspace_id: string }>();
      expect(row!.workspace_id).toBe(roots.companyWorkspaceId);
    }
  });

  it("a stale itemMap pointer to a deleted entry counts as missing and does not abort the batch", async () => {
    const { vectorize } = makeStatefulVectorizeMock();
    const { env, roots } = await makeEnv(vectorize);
    const helper = makeCtx();
    const ids = await seedMirrored(env, roots, helper, 2);

    const itemMap = itemMapFor(ids);
    // A third mapping whose entry was deleted out from under the integration
    // record — /forget, or a purge, or anything else outside sync.
    itemMap["page-999"] = { entryId: "entry-that-no-longer-exists", version: "v1" };
    await connectNotion(env, itemMap, "company");

    const res = await worker.fetch(moveRequest(), env, makeCtx().ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.missing).toBe(1);
    expect(data.moved).toBe(2); // the two real entries still moved
    expect(data.refused).toBe(0);

    for (const id of ids) {
      const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id).first<{ workspace_id: string }>();
      expect(row!.workspace_id).toBe(roots.companyWorkspaceId);
    }
  });

  it("a partial run over more items than the batch size reports remaining and a cursor, and draining it moves everything exactly once", async () => {
    const { vectorize } = makeStatefulVectorizeMock();
    const { env, roots } = await makeEnv(vectorize);
    const helper = makeCtx();
    const ids = await seedMirrored(env, roots, helper, 25);
    await connectNotion(env, itemMapFor(ids), "company");

    const first = await worker.fetch(moveRequest(), env, makeCtx().ctx);
    expect(first.status).toBe(200);
    const firstData = await first.json() as any;
    // Batch size 10 (locked decision 5) against 25 items.
    expect(firstData.moved).toBe(10);
    expect(firstData.remaining).toBe(15);
    expect(firstData.cursor).toBeTruthy();

    let cursor = firstData.cursor as string;
    let totalMoved = firstData.moved as number;
    let calls = 1;
    while (cursor) {
      const res = await worker.fetch(moveRequest(cursor), env, makeCtx().ctx);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      totalMoved += data.moved;
      cursor = data.cursor;
      calls++;
      expect(calls).toBeLessThanOrEqual(10); // guard against a stalled drain in the test itself
    }

    expect(totalMoved).toBe(25);
    expect(calls).toBe(3); // 10 + 10 + 5

    for (const id of ids) {
      const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id).first<{ workspace_id: string }>();
      expect(row!.workspace_id).toBe(roots.companyWorkspaceId);
    }
    // Every id moved exactly once: no duplicate rows, same 25 ids.
    const { results } = await env.DB.prepare(`SELECT id FROM entries WHERE source = 'notion'`).all<{ id: string }>();
    expect(results.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it("the author lock still applies after a move into company, and the author is still visible", async () => {
    const { vectorize } = makeStatefulVectorizeMock();
    const { env, roots } = await makeEnv(vectorize);
    const helper = makeCtx();
    const ids = await seedMirrored(env, roots, helper, 1);
    await connectNotion(env, itemMapFor(ids), "company");

    const moveRes = await worker.fetch(moveRequest(), env, makeCtx().ctx);
    expect(moveRes.status).toBe(200);
    expect(((await moveRes.json()) as any).moved).toBe(1);

    const dave = await createMember(env, { name: "Dave" }); // member, not the owner/actor

    // Author lock: a non-actor, non-admin teammate cannot forget the owner's
    // company-layer memory.
    const forgetRes = await worker.fetch(req("POST", "/forget", { body: { id: ids[0] }, token: dave.token }), env, makeCtx().ctx);
    expect(forgetRes.status).toBe(403);
    const forgetData = await forgetRes.json() as any;
    expect(forgetData.error).toContain("author");

    // The author is still visible on GET /list, as the owner's name — not
    // reassigned or nulled by the move.
    const listRes = await worker.fetch(req("GET", "/list?n=50", { token: dave.token }), env, makeCtx().ctx);
    const rows = await listRes.json() as any[];
    const moved = rows.find((r) => r.id === ids[0]);
    expect(moved).toBeTruthy();
    expect(moved.workspace).toBe("company");
  });

  it("writes exactly one audit row per call, named integration_memories_moved, with all four counts", async () => {
    const { vectorize } = makeStatefulVectorizeMock();
    const { env, roots } = await makeEnv(vectorize);
    const helper = makeCtx();
    const ids = await seedMirrored(env, roots, helper, 2);
    const itemMap = itemMapFor(ids);
    itemMap["page-999"] = { entryId: "gone", version: "v1" };
    await connectNotion(env, itemMap, "company");

    await worker.fetch(moveRequest(), env, makeCtx().ctx);

    const { results } = await env.DB.prepare(
      `SELECT event, payload FROM admin_events WHERE event = 'integration_memories_moved'`,
    ).all<{ event: string; payload: string }>();
    expect(results.length).toBe(1);
    const payload = JSON.parse(results[0].payload);
    expect(payload).toMatchObject({
      provider: "notion",
      target: "company",
      moved: 2,
      alreadyThere: 0,
      missing: 1,
      refused: 0,
    });
  });
});
