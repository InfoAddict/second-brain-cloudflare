/**
 * Track 2 (T-0089.2.1, T-0089.2.4) on a real workerd D1 (local wrangler, no Cloudflare account):
 * the supersede batch, the D-RET restore and re-close hooks and the cascade use numbered placeholders,
 * RETURNING with correlated reads, json_insert('$[#]') and UNION ALL aggregates, which node:sqlite
 * accepting them does not prove D1 does. Opt in with EVAL_WORKERD=1.
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { applyStatus, forgetEntry } from "../../src/capture/lifecycle";
import { getTrashedEntry, restoreEntry } from "../../src/memory/trash";
import { planSupersede, supersedeStatements, type Window } from "../../src/memory/validity";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

afterAll(cleanTemp);

describe.runIf(process.env.EVAL_WORKERD === "1")("validity hooks on workerd D1", () => {
  it("supersede, retraction with cascade, un-retraction, forget and restore", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
      await initializeDatabase(env);
      const seed = (id: string, createdAt: number, tags = "[]", actor = "u", source = "api") =>
        d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, '[]', 'w', ?)`)
          .bind(id, `content ${id}`, tags, source, createdAt, createdAt, actor).run();
      await seed("y", 1000);
      await seed("x", 2000);
      await seed("ins", 3000, '["auto-insight"]', "", "system");
      await d1.db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES ('d1', 'ins', 'x', 'drawn_from', 1, 'system', '{}', 1, 1, 'w')`).run();
      const row = async (id: string) => d1.db.prepare(`SELECT valid_until, tags FROM entries WHERE id = ?`).bind(id).first<{ valid_until: number | null; tags: string }>();
      const w = (id: string, from: number): Window => ({ id, from, until: null, workspaceId: "w", status: null });
      const change = { actorId: "u", channel: "rest" as const };

      await d1.db.batch(supersedeStatements(env, planSupersede(w("y", 1000), w("x", 2000)), w("y", 1000), w("x", 2000), change, DEFAULTS));
      expect((await row("y"))!.valid_until).toBe(2000);

      const wrong = await applyStatus("x", "deprecated", env, change, DEFAULTS, "w");
      expect(wrong).toMatchObject({ status: "ok", validity: { restored: [{ id: "y", preview: "content y" }], flagged: 1 } });
      expect((await row("y"))!.valid_until).toBeNull();
      expect(JSON.parse((await row("ins"))!.tags)).toEqual(expect.arrayContaining(["retracted-source", "status:draft"]));

      const back = await applyStatus("x", "canonical", env, change, DEFAULTS, "w");
      expect(back).toMatchObject({ status: "ok", validity: { reclosed: [{ id: "y" }], unflagged: 1 } });
      expect((await row("y"))!.valid_until).toBe(2000);
      expect(JSON.parse((await row("ins"))!.tags)).not.toContain("retracted-source");

      const gone = await forgetEntry("x", env, change, { reason: "forget", config: DEFAULTS, purge: false }, "w");
      expect(gone).toMatchObject({ status: "deleted", validity: { restored: [{ id: "y" }] } });
      const restored = await restoreEntry(env, (await getTrashedEntry(env, undefined, "x"))!, change, DEFAULTS);
      expect(restored).toMatchObject({ status: "restored", validity: { reclosed: [{ id: "y" }] } });
      expect((await row("y"))!.valid_until).toBe(2000);
    } finally {
      await d1.close();
    }
  }, 180_000);
});
