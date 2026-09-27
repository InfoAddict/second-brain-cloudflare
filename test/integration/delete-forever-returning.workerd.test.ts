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
  it("surfaces the live row's vector_ids and the trashed row's content", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const deleteByIds = vi.fn().mockResolvedValue({});
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock({ deleteByIds }) }) as Env;
      await initializeDatabase(env);
      const roots = await ensureTenantBootstrap(env);
      const seed = (id: string, vectorIds: string) => env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '[]', 'api', 1, 1, ?, ?, ?)`,
      ).bind(id, `content ${id}`, vectorIds, roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
      const change = { actorId: roots.ownerUserId, channel: "rest" as const };

      await seed("live1", '["live1","live1-update-9"]');
      expect(await deleteForever(env, "live1", change, roots.ownerPersonalWorkspaceId)).toEqual({ status: "deleted", from: "live", deletedVectors: 2 });
      expect(deleteByIds).toHaveBeenLastCalledWith(["live1", "live1-update-9"]);

      await seed("tr1", "[]");
      await env.DB.batch(trashManyStatements(env, planTrash(await readTrashCandidates(env, ["tr1"])), { reason: "forget", change, now: Date.now() }));
      expect(await deleteForever(env, "tr1", change, roots.ownerPersonalWorkspaceId)).toEqual({ status: "deleted", from: "trash", deletedVectors: 1 });
      expect(deleteByIds).toHaveBeenLastCalledWith(["tr1"]);
      const ev = await env.DB.prepare(`SELECT actor_id FROM entry_events WHERE entry_id = 'tr1' AND event = 'purged'`).first<{ actor_id: string }>();
      expect(ev?.actor_id).toBe(roots.ownerUserId);
    } finally {
      await d1.close();
    }
  }, 120_000);
});
