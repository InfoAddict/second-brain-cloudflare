/**
 * T-0100 / Builder C's Task 10 finding on T-0089.1.2: past roughly 10,700-12,500 incoming/outgoing
 * edges, edgesJsonSql's json_group_array aggregate (entry-columns.ts, read by trashSizeSelect in
 * trash.ts) exceeds real D1's per-value size ceiling and the read itself throws SQLITE_TOOBIG,
 * before chooseTrashTier ever runs. node:sqlite's own default SQLITE_MAX_LENGTH is ~1e9 bytes (it
 * takes millions of edges to reproduce there), but real D1 enforces a much smaller ceiling close to
 * the 2 MB TRASH_ROW_BUDGET_BYTES headroom, confirmed empirically against workerd below, not
 * against node:sqlite, per this project's own guidance for limits that are platform-specific.
 * Opt in with EVAL_WORKERD=1; local wrangler only, never a remote binding.
 */
import { describe, it, expect, afterAll } from "vitest";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { forgetEntry } from "../../src/capture/lifecycle";
import { trashMirroredEntries } from "../../src/memory/trash";
import type { Env } from "../../src/env";
import { DEFAULTS } from "../../src/config";

afterAll(cleanTemp);

// Comfortably past the measured crash boundary (~12,500 edges with a real UUID workspace_id;
// see the probe numbers in the builder report) so a small platform difference cannot flake this.
const EDGE_COUNT = 14_000;

async function seedHubWithEdges(env: Env, roots: { ownerPersonalWorkspaceId: string; ownerUserId: string }, id: string) {
  const row: Record<string, unknown> = {
    id, content: `content of ${id}`, tags: "[]", source: "api", created_at: 1000, updated_at: 1000,
    vector_ids: "[]", workspace_id: roots.ownerPersonalWorkspaceId, actor_id: roots.ownerUserId,
  };
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO entries (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
  // One INSERT ... SELECT over a recursive row source: far cheaper than one INSERT per edge.
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${EDGE_COUNT - 1})
     INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
     SELECT ? || '-e' || i, ?, 'other-' || i, 'relates_to', 0.5, 'inferred', '{}', 1, 1, ? FROM n`,
  ).bind(id, id, roots.ownerPersonalWorkspaceId).run();
}

describe.runIf(process.env.EVAL_WORKERD === "1")("forget on a row with too many edges to measure", () => {
  it("forgetEntry hard-deletes (tier 3) instead of crashing", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }) as Env;
      await initializeDatabase(env);
      const roots = await ensureTenantBootstrap(env);
      await seedHubWithEdges(env, roots, "hub");

      const change = { actorId: roots.ownerUserId, channel: "rest" as const };
      const result = await forgetEntry(
        "hub", env, change,
        { reason: "forget", config: DEFAULTS, purge: false },
        roots.ownerPersonalWorkspaceId,
      );

      // Tier 3: hard deleted, no trash row snapshot, the caller told it was too large for the trash.
      expect(result).toMatchObject({ status: "deleted", trashed: false });
      expect(await env.DB.prepare(`SELECT id FROM entries WHERE id = 'hub'`).first()).toBeNull();
      expect(await env.DB.prepare(`SELECT id FROM entries_trash WHERE id = 'hub'`).first()).toBeNull();
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM edges WHERE source_id = 'hub' OR target_id = 'hub'`).first()).toEqual({ n: 0 });
    } finally {
      await d1.close();
    }
  }, 120_000);

  it("trashMirroredEntries (the disconnect purge) hard-deletes instead of crashing", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }) as Env;
      await initializeDatabase(env);
      const roots = await ensureTenantBootstrap(env);
      await seedHubWithEdges(env, roots, "hub2");

      const owner = {
        userId: roots.ownerUserId, role: "admin",
        personalWorkspaceId: roots.ownerPersonalWorkspaceId, companyWorkspaceIds: [],
      } as any;
      const result = await trashMirroredEntries(env, owner, ["hub2"], { provider: "notion" });

      expect(result).toEqual({ purged: 1, skipped: 0 });
      expect(await env.DB.prepare(`SELECT id FROM entries WHERE id = 'hub2'`).first()).toBeNull();
      expect(await env.DB.prepare(`SELECT id FROM entries_trash WHERE id = 'hub2'`).first()).toBeNull();
      // Current contract: a tier-3 row's own life-end marker (trashManyStatements) is its only
      // "deleted" event -- trashMirroredEntries skips writing a second one for a tier-3 id (round
      // 4 re-review MINOR), so the marker's own shape is what lands here, not tooLargeForTrash.
      const event = await env.DB.prepare(`SELECT payload FROM entry_events WHERE entry_id = 'hub2' AND event = 'deleted'`).first<{ payload: string }>();
      expect(event).not.toBeNull();
      expect(JSON.parse(event!.payload)).toMatchObject({ trash: false, reason: "disconnect", channel: "rest" });
    } finally {
      await d1.close();
    }
  }, 120_000);
});
