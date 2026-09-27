/**
 * M1: every SQL builder in src/memory/trash.ts runs once against a real workerd D1 with the
 * Task 1 schema, so a placeholder-numbering bug (accepted by node:sqlite, rejected by real D1
 * with "Wrong number of parameter bindings") is caught here rather than in production.
 * Opt in with EVAL_WORKERD=1; local wrangler only, never a remote binding.
 *
 * Builder A's Task 2 owns the shared statement-builders.workerd.test.ts; this file covers
 * builder B's own builders pending that merge (see the builder report).
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import {
  chooseTrashTier, deleteForever, planTrash, purgeTrash, readTrashCandidates, restoreEntry,
  trashManyStatements, getTrashedEntry, trashMirroredEntries,
} from "../../src/memory/trash";
import type { Env } from "../../src/env";
import { DEFAULTS } from "../../src/config";

afterAll(cleanTemp);

describe.runIf(process.env.EVAL_WORKERD === "1")("trash statement builders on workerd", () => {
  it("forget, purge, restore and Delete forever all run against real D1", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }) as Env;
      await initializeDatabase(env);
      const roots = await ensureTenantBootstrap(env);
      const seed = (id: string, extra: Record<string, unknown> = {}) => {
        const row: Record<string, unknown> = {
          id, content: `content ${id}`, tags: "[]", source: "api", created_at: 1000, updated_at: 1000,
          vector_ids: "[]", workspace_id: roots.ownerPersonalWorkspaceId, actor_id: roots.ownerUserId, ...extra,
        };
        const cols = Object.keys(row);
        return env.DB.prepare(`INSERT INTO entries (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
      };
      const change = { actorId: roots.ownerUserId, channel: "rest" as const };

      // Tier 1 forget (with an edge).
      await seed("a"); await seed("b");
      await env.DB.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES ('e1','a','b','relates_to',0.5,'explicit','{}',1,1,?)`).bind(roots.ownerPersonalWorkspaceId).run();
      const [sizes] = await readTrashCandidates(env, ["a"]);
      expect(chooseTrashTier(sizes)).toBe(1);
      const plan = planTrash([sizes]);
      await env.DB.batch(trashManyStatements(env, plan, { reason: "forget", change, now: Date.now() }));
      expect(await env.DB.prepare(`SELECT id FROM entries WHERE id = 'a'`).first()).toBeNull();
      expect(await env.DB.prepare(`SELECT id FROM entries_trash WHERE id = 'a'`).first()).not.toBeNull();

      // Purge (the candidate read and the purge batch). now is pushed two days out so the row
      // (deleted "now") clears even TRASH_RETENTION_DAYS's floor of 1 day.
      const purged = await purgeTrash(env, { ...DEFAULTS, TRASH_RETENTION_DAYS: 1 }, { ceiling: 10, rowTarget: 5000, now: Date.now() + 2 * 86_400_000 });
      expect(purged.purged).toBe(1);

      // Restore.
      await seed("c");
      await env.DB.batch(trashManyStatements(env, planTrash(await readTrashCandidates(env, ["c"])), { reason: "forget", change, now: Date.now() }));
      const trashed = await getTrashedEntry(env, undefined, "c");
      const restored = await restoreEntry(env, trashed!, change, DEFAULTS);
      expect(restored.status).toBe("restored");
      expect(await env.DB.prepare(`SELECT id FROM entries WHERE id = 'c'`).first()).not.toBeNull();

      // Delete forever, live and trashed.
      const live = await deleteForever(env, { id: "c", vector_ids: "[]" }, change);
      expect(live).toMatchObject({ status: "deleted", from: "live" });
      await seed("d");
      await env.DB.batch(trashManyStatements(env, planTrash(await readTrashCandidates(env, ["d"])), { reason: "forget", change, now: Date.now() }));
      const trashResult = await deleteForever(env, { id: "d" }, change);
      expect(trashResult).toMatchObject({ status: "deleted", from: "trash" });
      expect(await env.DB.prepare(`SELECT id FROM entries_trash WHERE id = 'd'`).first()).toBeNull();

      // The disconnect purge's own scoped read and batch (trashMirroredEntries).
      await seed("e");
      const owner = { userId: roots.ownerUserId, role: "admin", personalWorkspaceId: roots.ownerPersonalWorkspaceId, companyWorkspaceIds: [] } as any;
      const mirrorResult = await trashMirroredEntries(env, owner, ["e"], { provider: "notion" });
      expect(mirrorResult).toEqual({ purged: 1, skipped: 0 });
      expect(await env.DB.prepare(`SELECT reason FROM entries_trash WHERE id = 'e'`).first()).toEqual({ reason: "disconnect" });
    } finally {
      await d1.close();
    }
  }, 120_000);
});
