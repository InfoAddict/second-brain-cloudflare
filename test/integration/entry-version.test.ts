/**
 * BE-8 (T-0101.1.1, T-0101.3.2): readEntryVersion, contract 4.2's full text/tags/status of one
 * visible version, for GET /entry/version and MCP get(id, version). Real SQLite throughout, since
 * the shared-history cut and buildChain's own reconstruction are the SQL and the walk, not
 * something a JS mock can evaluate. Versions are seeded through the real snapshot SQL, the same
 * shape entry-history.test.ts's own `edit` helper uses.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { resolveConfig } from "../../src/config";
import { snapshotStatement, pruneStatement, type VersionReason } from "../../src/memory/versions";
import { readEntryVersion } from "../../src/memory/history-view";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let companyWs = "";

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  companyWs = roots.companyWorkspaceId;
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

const seedRow = (id: string, content: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, ?, '[]', ?, ?)`,
).bind(
  id, content, JSON.stringify(over.tags ?? []), over.createdAt ?? 1000, over.updatedAt ?? null,
  over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId,
).run();

const row = async (id: string) => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as Record<string, any>;

/** A real writer, shaped like versions.ts's own [snapshot, UPDATE, prune] batch. */
async function edit(id: string, next: string, over: {
  reason?: VersionReason; actorId?: string; channel?: string; meta?: Record<string, unknown>; now?: number; tags?: string[]; keep?: number;
} = {}) {
  const current = await row(id);
  const tags = over.tags ?? JSON.parse(current.tags ?? "[]");
  const now = over.now ?? 1000;
  await sqlite.db.batch([
    snapshotStatement(env, {
      entryId: id, reason: over.reason ?? "update", change: { actorId: over.actorId ?? owner.userId, channel: (over.channel ?? "rest") as any },
      content: { kind: "next", content: next }, nextTags: tags, meta: over.meta, now,
    }),
    sqlite.db.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ?`).bind(next, JSON.stringify(tags), now, id),
    pruneStatement(env, id, over.keep ?? 20),
  ] as any[]);
}

async function member(name: string, role: "admin" | "member" = "member"): Promise<Identity> {
  const { token } = await createMember(env, { name, role });
  return (await resolveIdentityFromToken(token, env))!;
}

describe("readEntryVersion", () => {
  it("returns the full text, tags, status, reason, channel, client and actor_name of a visible version", async () => {
    await seedRow("e1", "first text");
    await edit("e1", "second text", { now: 1000, channel: "mcp", meta: { client: "Claude" }, tags: ["work", "status:canonical"] });
    const config = await resolveConfig(env);
    const result = await readEntryVersion(env, owner, "e1", 1, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe("first text");
    expect(result.tags).toEqual([]);
    expect(result.status).toBeNull();
    expect(result.reason).toBe("update");
    expect(result.channel).toBe("mcp");
    expect(result.client).toBe("Claude");
    expect(result.seq).toBe(1);
  });

  it("no_version for a seq that was never recorded", async () => {
    await seedRow("e2", "v0");
    await edit("e2", "v1", { now: 1000 });
    const config = await resolveConfig(env);
    const result = await readEntryVersion(env, owner, "e2", 99, config);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_version");
  });

  it("pruned for a seq below the oldest kept version, chain not cut", async () => {
    await seedRow("e3", "v0");
    const config = await resolveConfig(env);
    for (let i = 1; i <= config.VERSION_KEEP + 3; i++) {
      await edit("e3", `v${i}`, { now: 1000 + i, keep: config.VERSION_KEEP });
    }
    // seq 1 existed once but is below the oldest kept row after VERSION_KEEP+3 edits.
    const result = await readEntryVersion(env, owner, "e3", 1, config);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("pruned");
  });

  it("not_visible when the entry itself is out of the caller's authorized workspace", async () => {
    const other = await member("Dana");
    await seedRow("e4", "v0", { workspaceId: other.personalWorkspaceId, actorId: other.userId });
    const config = await resolveConfig(env);
    expect((await readEntryVersion(env, owner, "missing", 1, config)).ok).toBe(false);
    const result = await readEntryVersion(env, owner, "e4", 1, config);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_visible");
  });

  it("a trashed row is not_visible, not a distinguishable state", async () => {
    await seedRow("e5", "v0");
    await edit("e5", "v1", { now: 1000 });
    await sqlite.db.prepare(`DELETE FROM entries WHERE id = 'e5'`).run();
    const config = await resolveConfig(env);
    const result = await readEntryVersion(env, owner, "e5", 1, config);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_visible");
  });

  it("D-SH: a teammate cannot read a pre-share version", async () => {
    const author = await member("Bob");
    const teammate = await member("Carla");
    await seedRow("e6", "state0", { workspaceId: author.personalWorkspaceId, actorId: author.userId, createdAt: 100 });
    // Private-era version, below the share point.
    await edit("e6", "state1", { now: 200, actorId: author.userId });
    // Share: the row moves to the company workspace.
    await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'e6'`).bind(companyWs).run();
    // Post-share version: workspace_id now copies the row's current (company) workspace_id.
    await edit("e6", "state2", { now: 400, actorId: author.userId });
    const config = await resolveConfig(env);

    const visible = await readEntryVersion(env, teammate, "e6", 2, config);
    expect(visible.ok).toBe(true);

    const hidden = await readEntryVersion(env, teammate, "e6", 1, config);
    expect(hidden.ok).toBe(false);
    if (hidden.ok) return;
    expect(hidden.reason).toBe("not_visible");

    // The author themselves can still read the pre-share version.
    const asAuthor = await readEntryVersion(env, author, "e6", 1, config);
    expect(asAuthor.ok).toBe(true);
  });
});
