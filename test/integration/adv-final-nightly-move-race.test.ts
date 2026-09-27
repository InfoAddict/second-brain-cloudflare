import { afterEach, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { moveEntry } from "../../src/capture/share";
import { runNightlyVectorizePending } from "../../src/vectorize/pending";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

it("a deferred embed cannot commit old-workspace vectors after a share", async () => {
  t = await makeTrashEnv();
  t.seed("deferred-move", { content: "a fact shared during nightly indexing", created_at: Date.now() - 60 * 60_000 });
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;
  const stamped: { id: string; workspace_id: string }[] = [];
  const original = t.env.VECTORIZE.upsert.bind(t.env.VECTORIZE);
  let moved = false;
  (t.env.VECTORIZE as any).upsert = async (vectors: any[]) => {
    stamped.push(...vectors.map(v => ({ id: v.id, workspace_id: v.metadata.workspace_id })));
    const result = await original(vectors);
    if (!moved) {
      moved = true;
      expect((await moveEntry("deferred-move", "company", t.env, owner,
        { actorId: owner.userId, channel: "rest" })).status).toBe("shared");
    }
    return result;
  };

  await runNightlyVectorizePending(t.env, DEFAULTS);
  const row = (await t.one<{ workspace_id: string; vector_ids: string }>(
    "SELECT workspace_id, vector_ids FROM entries WHERE id = 'deferred-move'"))!;
  expect(moved).toBe(true);
  expect(row.workspace_id).toBe(t.roots.companyWorkspaceId);
  expect(JSON.parse(row.vector_ids)).toEqual(stamped.map(v => v.id));
  expect(stamped.every(v => v.workspace_id === row.workspace_id)).toBe(true);
});
