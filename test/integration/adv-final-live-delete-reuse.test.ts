import { afterEach, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { assertCanMutateEntry, getReadableEntry } from "../../src/lib/entry-access";
import { forgetEntry } from "../../src/capture/lifecycle";
import { deleteForever, getTrashedEntry } from "../../src/memory/trash";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

it("a live-authorized Delete forever cannot consume another teammate's later trash row under a reused company ID", async () => {
  t = await makeTrashEnv();
  const { member: alice } = await createMember(t.env, { name: "Alice" });
  const { member: bob } = await createMember(t.env, { name: "Bob" });
  const aliceIdentity = (await resolveIdentityByUserId(t.env, alice.userId))!;
  const company = t.roots.companyWorkspaceId;
  const change = { actorId: alice.userId, channel: "rest" as const };

  t.seed("reused-company", { content: "Alice's company memory", actor_id: alice.userId, workspace_id: company });
  const authorizedLive = await getReadableEntry(t.env, aliceIdentity, "reused-company", "id, workspace_id, actor_id");
  expect(authorizedLive).not.toBeNull();
  expect(assertCanMutateEntry(aliceIdentity, authorizedLive!)).toBeNull();

  // Interleaving after the route's authorization read: Alice removes her original ID;
  // Bob reuses the now-free ID, then forgets his own company memory.
  await forgetEntry("reused-company", t.env, change,
    { reason: "forget", config: DEFAULTS, purge: false }, company);
  const oldTrash = (await getTrashedEntry(t.env, aliceIdentity, "reused-company"))!;
  expect((await deleteForever(t.env, "reused-company", change, company, oldTrash.nonce)).status).toBe("deleted");
  t.seed("reused-company", { content: "Bob's company memory", actor_id: bob.userId, workspace_id: company });
  await forgetEntry("reused-company", t.env, { actorId: bob.userId, channel: "rest" },
    { reason: "forget", config: DEFAULTS, purge: false }, company);

  // The live-authorized request carried no trash nonce; the API no longer accepts one without it.
  const pendingAliceDelete = await deleteForever(t.env, "reused-company", change, company, undefined as unknown as string);
  expect(pendingAliceDelete.status).not.toBe("deleted");
  expect(await t.one<{ actor_id: string }>("SELECT actor_id FROM entries_trash WHERE id = ?", "reused-company"))
    .toMatchObject({ actor_id: bob.userId });
});
