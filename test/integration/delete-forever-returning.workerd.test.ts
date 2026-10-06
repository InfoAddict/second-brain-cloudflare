/**
 * Adversary round 2 (T-0089.4.7): Delete forever's RETURNING clauses inside a batch on real workerd D1.
 * A status-only check passes even if RETURNING yields no rows (from/not_found come from changes), so
 * this asserts the vectors RETURNING should surface. Opt in with EVAL_WORKERD=1; local only.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { deleteForever, planTrash, readTrashCandidates, trashManyStatements } from "../../src/memory/trash";
import type { Env } from "../../src/env";

afterAll(cleanTemp);

describe.runIf(process.env.EVAL_WORKERD === "1")("Delete forever RETURNING on workerd", () => {
  it("surfaces the trash row's stored vector_ids and content, and never deletes a live row", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const deleteByIds = vi.fn().mockResolvedValue({});
      // makeVectorizeMock's default getByIds resolves ownership via db.__vectorOwners() (the
      // SQLite test double's own bookkeeping, test/helpers/sqlite-d1.ts) -- real workerd D1 has no
      // such method, so every id would come back "not found" and deleteEntryVectors would never
      // call deleteByIds at all. Real vectors carry metadata.parentId set at upsert time
      // (capture/store.ts:179); deleteEntryVectors's owners.has(v.id) fallback (no parentId) is
      // only for the true legacy case where the vector id IS the entry id, so a chunk id like
      // "tr0-update-9" needs its real parentId echoed back, not an empty metadata object, or
      // deleteEntryVectors silently drops it as unowned.
      const getByIds = vi.fn(async (ids: string[]) =>
        ids.map(id => ({ id, values: [], metadata: { parentId: id.replace(/-update-\d+$/, "") } })));
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock({ deleteByIds, getByIds }) }) as Env;
      await initializeDatabase(env);
      const roots = await ensureTenantBootstrap(env);
      const seed = (id: string, vectorIds: string) => env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '[]', 'api', 1, 1, ?, ?, ?)`,
      ).bind(id, `content ${id}`, vectorIds, roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      const change = { actorId: roots.ownerUserId, channel: "rest" as const };

      const trash = async (id: string) => env.DB.batch(trashManyStatements(env, planTrash(await readTrashCandidates(env, [id])), { reason: "forget", change, now: Date.now() }));
      const nonce = async (id: string) => (await env.DB.prepare(`SELECT nonce FROM entries_trash WHERE id = ?`).bind(id).first<{ nonce: string }>())!.nonce;

      // A live row is never deleted forever, only its trash row, pinned by nonce.
      await seed("live1", '["live1","live1-update-9"]');
      expect(await deleteForever(env, "live1", change, roots.ownerPersonalWorkspaceId, "")).toEqual({ status: "not_found" });
      expect(await env.DB.prepare(`SELECT id FROM entries WHERE id = 'live1'`).first()).not.toBeNull();

      // The stored vector ids (id-update-<ts>) come back through RETURNING on workerd too.
      await env.DB.prepare(`DELETE FROM entries WHERE id = 'live1'`).run();
      await seed("tr0", '["tr0","tr0-update-9"]');
      await trash("tr0");
      expect(await deleteForever(env, "tr0", change, roots.ownerPersonalWorkspaceId, await nonce("tr0"))).toEqual({ status: "deleted", deletedVectors: 2 });
      expect(deleteByIds).toHaveBeenLastCalledWith(["tr0", "tr0-update-9"]);

      await seed("tr1", "[]");
      await trash("tr1");
      expect(await deleteForever(env, "tr1", change, roots.ownerPersonalWorkspaceId, await nonce("tr1"))).toEqual({ status: "deleted", deletedVectors: 1 });
      expect(deleteByIds).toHaveBeenLastCalledWith(["tr1"]);
      const ev = await env.DB.prepare(`SELECT actor_id FROM entry_events WHERE entry_id = 'tr1' AND event = 'purged'`).first<{ actor_id: string }>();
      expect(ev?.actor_id).toBe(roots.ownerUserId);
    } finally {
      await d1.close();
    }
  }, 120_000);
});
