import { afterEach, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { forgetEntry } from "../../src/capture/lifecycle";
import { getTrashedEntry, restoreEntry } from "../../src/memory/trash";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

it("a stale restore cannot restore a different member's new trash row with the same id", async () => {
  t = await makeTrashEnv();
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;
  const { member: bob } = await createMember(t.env, { name: "Bob" });

  t.seed("reused", { content: "owner's memory" });
  await forgetEntry("reused", t.env, { actorId: owner.userId, channel: "rest" },
    { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
  const ownerRead = (await getTrashedEntry(t.env, owner, "reused"))!;

  // Interleaving: the old trash expires and is purged; Bob imports the same id and forgets it.
  await t.env.DB.prepare("DELETE FROM entries_trash WHERE id = ?").bind("reused").run();
  t.seed("reused", { content: "Bob's private memory", actor_id: bob.userId,
    workspace_id: bob.personalWorkspaceId });
  await forgetEntry("reused", t.env, { actorId: bob.userId, channel: "rest" },
    { reason: "forget", config: DEFAULTS, purge: false }, bob.personalWorkspaceId);

  const result = await restoreEntry(t.env, ownerRead, { actorId: owner.userId, channel: "rest" }, DEFAULTS);
  expect(await t.one("SELECT id FROM entries WHERE id = ?", "reused")).toBeNull();
  expect(result.status).not.toBe("restored");
  expect(await t.one<{ workspace_id: string }>("SELECT workspace_id FROM entries_trash WHERE id = ?", "reused"))
    .toMatchObject({ workspace_id: bob.personalWorkspaceId });
});
