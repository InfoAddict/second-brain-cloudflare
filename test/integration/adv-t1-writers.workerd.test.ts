/**
 * Adversary (T-0089.1.1, round 2): the writers rewritten in 0b6d041/7d6f16a7 (`UPDATE entries AS e`, buildCasGuard
 * with `IS ?N` for NULL, prior_length_utf16) run once each on a real workerd D1. statement-builders.workerd.test.ts
 * covers only the versions.ts builders. Opt in with EVAL_WORKERD=1 (local wrangler, no Cloudflare account).
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { updateEntryContent, appendToEntry } from "../../src/capture/store";
import { resolveEntryAction } from "../../src/memory/actions";
import { loadHistory } from "../../src/memory/versions";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

afterAll(cleanTemp);

describe.runIf(process.env.EVAL_WORKERD === "1")("rewritten writers on workerd D1", () => {
  it("update, short and long append, snooze with NULL when_* and loops done all commit and reconstruct", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
      await initializeDatabase(env);
      const roots = await ensureTenantBootstrap(env);
      const owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
      const ws = roots.ownerPersonalWorkspaceId;
      const ins = (id: string, content: string, tags: string[], whenAt: number | null) => d1.db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, when_at, when_kind) VALUES (?, ?, ?, 'api', 1, NULL, '[]', ?, ?, ?, ?)`,
      ).bind(id, content, JSON.stringify(tags), ws, owner.userId, whenAt, whenAt ? "due" : null).run();
      await ins("e1", "Base 😀 text", [], null);
      await ins("t1", "a task", ["task"], null);
      await ins("d1", "due thing", [], 5_000_000_000_000);
      const wctx = { workspaceId: ws, actorId: owner.userId };
      const change = { actorId: owner.userId, channel: "rest" as const };

      expect((await updateEntryContent(env, "e1", "Base 😀 text, edited", DEFAULTS, undefined, undefined, wctx, change, ws)).status).toBe("updated");
      await appendToEntry(env, "e1", "", "short 🎉", [], "api", DEFAULTS, undefined, wctx, change, undefined, ws);
      await appendToEntry(env, "e1", "", "long ".repeat(400), [], "api", DEFAULTS, undefined, wctx, change, undefined, ws);
      expect((await resolveEntryAction(env, { waitUntil() {} }, owner, "t1", "done", undefined, change)).ok).toBe(true);
      expect((await resolveEntryAction(env, { waitUntil() {} }, owner, "d1", "snooze", new Date(Date.now() + 86_400_000).toISOString(), change)).ok).toBe(true);

      const row = await d1.db.prepare(`SELECT content FROM entries WHERE id = 'e1'`).first<{ content: string }>();
      const chain = await loadHistory(env, undefined, { id: "e1", content: row!.content }, 20);
      expect(chain.rows.map(r => r.seq)).toEqual([3, 2, 1]);
      expect(chain.text(1)).toBe("Base 😀 text");
      expect(chain.text(2)).toBe("Base 😀 text, edited");
      expect(chain.text(3).startsWith("Base 😀 text, edited\n\n[Update")).toBe(true);
      expect(chain.text(3).endsWith("short 🎉")).toBe(true);
    } finally {
      await d1.close();
    }
  }, 180_000);
});
