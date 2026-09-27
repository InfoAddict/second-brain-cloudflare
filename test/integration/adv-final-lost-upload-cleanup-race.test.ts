import { afterEach, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { moveEntry } from "../../src/capture/share";
import { storeEntry } from "../../src/capture/store";
import { runNightlyVectorizePending } from "../../src/vectorize/pending";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

it("stale-upload cleanup cannot delete a concurrent winner's deterministic vector", async () => {
  t = await makeTrashEnv();
  const content = "a deferred fact whose owner shares it";
  t.seed("race", { content, created_at: Date.now() - 60 * 60_000 });
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;
  const present = new Map<string, string>();
  const upsert = t.env.VECTORIZE.upsert.bind(t.env.VECTORIZE);
  const remove = t.env.VECTORIZE.deleteByIds.bind(t.env.VECTORIZE);
  let moved = false;
  let winnerCommitted = false;
  (t.env.VECTORIZE as any).upsert = async (vectors: any[]) => {
    for (const v of vectors) present.set(v.id, v.metadata.workspace_id);
    const result = await upsert(vectors);
    if (!moved) {
      moved = true;
      expect((await moveEntry("race", "company", t.env, owner,
        { actorId: owner.userId, channel: "rest" })).status).toBe("shared");
    }
    return result;
  };
  (t.env.VECTORIZE as any).deleteByIds = async (ids: string[]) => {
    if (!winnerCommitted) {
      const winner = await storeEntry(t.env, "race", content, [], "api", Date.now(), DEFAULTS,
        { workspaceId: t.roots.companyWorkspaceId, actorId: owner.userId });
      expect(winner.committed).toBe(true);
      winnerCommitted = true;
    }
    for (const id of ids) present.delete(id);
    return remove(ids);
  };

  await runNightlyVectorizePending(t.env, DEFAULTS);
  const row = (await t.one<{ vector_ids: string }>("SELECT vector_ids FROM entries WHERE id = 'race'"))!;
  const ids = JSON.parse(row.vector_ids) as string[];
  expect(winnerCommitted).toBe(true);
  expect(ids).toEqual(["race"]);
  expect(ids.every(id => present.get(id) === t.roots.companyWorkspaceId)).toBe(true);
});
