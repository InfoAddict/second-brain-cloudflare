/**
 * ADV-U13 on real workerd D1 (local wrangler, no Cloudflare account). node:sqlite has no row-size
 * limit at all, and Miniflare/workerd D1 does not enforce the 2 MB limit either (Verified facts,
 * "Miniflare accepted a 2.1 MB row"), so neither environment can prove a REJECTED oversized write.
 * What this proves instead: revertEntry's own dense parameter binding and batch execution succeed
 * against a real D1 engine for a large merge, and the row's measured bytes (computed by the same SQL
 * both engines run) land under the limit exactly as the node:sqlite test predicts. The merge state is
 * seeded directly (rather than through captureEntry) so this exercises only revertEntry's own
 * statements — captureEntry's classify/dedup background passes are unrelated to this finding and, on
 * this wrangler version, do not tolerate a platform-proxy D1 binding. Opt in with EVAL_WORKERD=1.
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock, makeAIMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { revertEntry } from "../../src/memory/undo";
import { D1_ROW_MAX_BYTES } from "../../src/constants";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

afterAll(cleanTemp);

describe.runIf(process.env.EVAL_WORKERD === "1")("ADV-U13 (MAJOR) on workerd D1: undoing a large merge", () => {
  it("the revert's own version row stays under D1's 2,000,000-byte row limit", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, {
        DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(), AI: makeAIMock(),
      }) as Env;
      await initializeDatabase(env);
      const roots = await ensureTenantBootstrap(env);
      const owner = (await resolveIdentityByUserId(env, roots.ownerUserId))! as Identity;

      // The state a real merge leaves behind: the row already holds the merged (combined) text, and
      // its own version records the pre-merge text plus the absorbed capture in meta.incoming — the
      // exact shape captureEntry's merge writer produces (entry.ts), seeded directly here so this test
      // exercises only revertEntry's own statements against workerd D1.
      const preMerge = "a".repeat(700_000);
      const incoming = "b".repeat(1_000_000);
      const merged = `${preMerge} ${incoming}`;
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '["work"]', 'api', 1000, 1000, '["big"]', ?, ?)`
      ).bind("big", merged, owner.personalWorkspaceId, owner.userId).run();
      const mergeMeta = JSON.stringify({ incoming, incomingTags: [], incomingSource: "api" });
      // preMerge is a prefix of merged, so a real merge writer stores this as a delta (prior_length,
      // content NULL), never a full copy of the pre-merge text.
      await env.DB.prepare(
        `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, state, actor_id, channel, reason, meta, valid_from, created_at)
         VALUES (?, ?, 1, NULL, ?, '["work"]', '{}', ?, 'rest', 'merge', ?, 1000, 1000)`
      ).bind("big", owner.personalWorkspaceId, preMerge.length, owner.userId, mergeMeta).run();

      const r = await revertEntry(env, owner, "big", { actorId: owner.userId, channel: "rest" }, DEFAULTS, undefined, owner.personalWorkspaceId);
      expect(r.status).toBe("reverted");
      const revertRow = await env.DB.prepare(
        `SELECT COALESCE(length(CAST(content AS BLOB)), 0) + length(CAST(meta AS BLOB)) + length(CAST(tags AS BLOB)) + length(CAST(state AS BLOB)) AS bytes
           FROM entry_versions WHERE entry_id = 'big' AND reason = 'revert'`,
      ).first<{ bytes: number }>();
      expect(revertRow!.bytes).toBeLessThanOrEqual(D1_ROW_MAX_BYTES);
    } finally {
      await d1.close();
    }
  }, 120_000);
});
