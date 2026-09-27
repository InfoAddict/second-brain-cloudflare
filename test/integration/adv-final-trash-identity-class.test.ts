import { afterEach, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { createMember, cleanupMemberData } from "../../src/lib/team-admin";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { forgetEntry } from "../../src/capture/lifecycle";
import { getTrashedEntry, restoreEntry, deleteForever, purgeTrash } from "../../src/memory/trash";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

const forget = (id: string, actorId: string, workspaceId: string) =>
  forgetEntry(id, t.env, { actorId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, workspaceId);

/**
 * Structural coverage for adv-final MAJOR 1 ("restore can consume the wrong trash row"), treated
 * as a class: every trash mutation must be conditional on the exact row (or the exact current
 * workspace state) it acts on, never on an id alone or a stale earlier read. One test, one section
 * per mutation, each its own id so the four scenarios cannot interfere with each other.
 */
it("every trash mutation is conditional on the exact row it read or the workspace it is scoped to, not id alone", async () => {
  t = await makeTrashEnv();
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;

  // 1. restore: a stale read must not consume a different member's trash row that later reused the same id.
  {
    const { member: bob } = await createMember(t.env, { name: "Bob-restore" });
    t.seed("id-restore", { content: "owner's memory" });
    await forget("id-restore", owner.userId, owner.personalWorkspaceId);
    const ownerRead = (await getTrashedEntry(t.env, owner, "id-restore"))!;

    // Interleaving: the owner's trash row expires and is purged; Bob captures and forgets the same id.
    await t.env.DB.prepare("DELETE FROM entries_trash WHERE id = ?").bind("id-restore").run();
    t.seed("id-restore", { content: "Bob's private memory", actor_id: bob.userId, workspace_id: bob.personalWorkspaceId });
    await forget("id-restore", bob.userId, bob.personalWorkspaceId);

    const result = await restoreEntry(t.env, ownerRead, { actorId: owner.userId, channel: "rest" }, DEFAULTS);
    expect(result.status).not.toBe("restored");
    expect(await t.one("SELECT id FROM entries WHERE id = ?", "id-restore")).toBeNull();
    expect(await t.one<{ workspace_id: string }>("SELECT workspace_id FROM entries_trash WHERE id = ?", "id-restore"))
      .toMatchObject({ workspace_id: bob.personalWorkspaceId });
  }

  // 2. Delete forever: a stale authorizedWorkspaceId must not permanently delete a different
  // member's trash row that later reused the same id.
  {
    const { member: bob } = await createMember(t.env, { name: "Bob-delete" });
    t.seed("id-delete", { content: "owner's memory" });
    await forget("id-delete", owner.userId, owner.personalWorkspaceId);
    const ownerRead = (await getTrashedEntry(t.env, owner, "id-delete"))!;

    await t.env.DB.prepare("DELETE FROM entries_trash WHERE id = ?").bind("id-delete").run();
    t.seed("id-delete", { content: "Bob's private memory", actor_id: bob.userId, workspace_id: bob.personalWorkspaceId });
    await forget("id-delete", bob.userId, bob.personalWorkspaceId);

    const result = await deleteForever(t.env, "id-delete", { actorId: owner.userId, channel: "rest" }, ownerRead.workspace_id);
    expect(result.status).not.toBe("deleted");
    expect(await t.one<{ workspace_id: string }>("SELECT workspace_id FROM entries_trash WHERE id = ?", "id-delete"))
      .toMatchObject({ workspace_id: bob.personalWorkspaceId });
  }

  // 3. Purge: a row that was a genuinely expired candidate when the nightly sweep read it, but got
  // replaced by a fresh, unexpired row under the same id before the delete batch actually ran, must survive.
  {
    const { member: bob } = await createMember(t.env, { name: "Bob-purge" });
    await t.sqlite.db.exec(
      `INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason)
       VALUES ('id-purge', '${t.roots.ownerPersonalWorkspaceId}', '', 'c', '{"created_at":1}', '[]', '[]', 1, '', 'rest', 'forget')`,
    );

    const realBatch = t.env.DB.batch.bind(t.env.DB);
    let swapped = false;
    (t.env.DB as unknown as { batch: typeof realBatch }).batch = async (stmts) => {
      if (!swapped) {
        swapped = true;
        await t.env.DB.prepare("DELETE FROM entries_trash WHERE id = ?").bind("id-purge").run();
        t.seed("id-purge", { content: "Bob's fresh memory", actor_id: bob.userId, workspace_id: bob.personalWorkspaceId });
        await forget("id-purge", bob.userId, bob.personalWorkspaceId);
      }
      return realBatch(stmts);
    };
    try {
      await purgeTrash(t.env, DEFAULTS, { ceiling: 100, rowTarget: 5000, now: Date.now() });
    } finally {
      (t.env.DB as unknown as { batch: typeof realBatch }).batch = realBatch;
    }

    expect(await t.one<{ workspace_id: string }>("SELECT workspace_id FROM entries_trash WHERE id = ?", "id-purge"))
      .toMatchObject({ workspace_id: bob.personalWorkspaceId });
  }

  // 4. Member removal: the final sweep must act on the workspace's rows as they are when it runs,
  // not a pre-computed id list from earlier in the same call, and must never touch another workspace.
  {
    const { member: bob } = await createMember(t.env, { name: "Bob-removed" });
    t.seed("id-mr-old", { content: "old", workspace_id: bob.personalWorkspaceId, actor_id: bob.userId });
    await forget("id-mr-old", bob.userId, bob.personalWorkspaceId);
    t.seed("id-mr-owner", { content: "owner's own" });
    await forget("id-mr-owner", owner.userId, owner.personalWorkspaceId);

    const realBatch = t.env.DB.batch.bind(t.env.DB);
    let injected = false;
    (t.env.DB as unknown as { batch: typeof realBatch }).batch = async (stmts) => {
      // cleanupMemberData's final sweep is its only 6-statement batch; everything upstream (the
      // chunked version cleanup, and createMember/forgetEntry called from inside this hook) uses
      // .run() or a smaller batch, so this only fires once, right before the sweep itself.
      if (!injected && stmts.length === 6) {
        injected = true;
        t.seed("id-mr-new", { content: "forgotten after the scan", workspace_id: bob.personalWorkspaceId, actor_id: bob.userId });
        await forget("id-mr-new", bob.userId, bob.personalWorkspaceId);
      }
      return realBatch(stmts);
    };
    try {
      await cleanupMemberData(t.env, bob.userId, bob.personalWorkspaceId);
    } finally {
      (t.env.DB as unknown as { batch: typeof realBatch }).batch = realBatch;
    }

    expect(await t.one("SELECT id FROM entries_trash WHERE id = ?", "id-mr-old")).toBeNull();
    expect(await t.one("SELECT id FROM entries_trash WHERE id = ?", "id-mr-new")).toBeNull();
    expect(await t.one("SELECT id FROM entries_trash WHERE id = ?", "id-mr-owner")).not.toBeNull();
  }
});
