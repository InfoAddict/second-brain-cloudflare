import { afterEach, expect, it } from "vitest";
import { makeTrashEnv, trashNonce, type TrashEnv } from "../helpers/trash-env";
import { forgetEntry } from "../../src/capture/lifecycle";
import { deleteForever } from "../../src/memory/trash";
import { chunkText } from "../../src/text/chunk";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

it("Delete forever of a legacy multi-chunk row preserves a live entry whose id aliases a derived chunk id", async () => {
  t = await makeTrashEnv();
  const longContent = "A legacy memory. ".repeat(150);
  expect(chunkText(longContent).length).toBeGreaterThan(1);
  t.seed("legacy", { content: longContent, vector_ids: "[]" });
  const workspaceId = t.roots.ownerPersonalWorkspaceId;
  const change = { actorId: t.roots.ownerUserId, channel: "rest" as const };
  expect((await forgetEntry("legacy", t.env, change,
    { reason: "forget", config: DEFAULTS, purge: false }, workspaceId)).status).toBe("deleted");

  // Both names were valid in 3.7: the legacy note's first chunk and another entry's own id.
  const survivorId = "legacy-chunk-0";
  t.seed(survivorId, { content: "a different live memory", vector_ids: JSON.stringify([survivorId]) });
  const present = new Set([survivorId]);
  const deleted: string[] = [];
  const original = t.env.VECTORIZE.deleteByIds.bind(t.env.VECTORIZE);
  (t.env.VECTORIZE as any).deleteByIds = async (ids: string[]) => {
    deleted.push(...ids);
    ids.forEach(id => present.delete(id));
    return original(ids);
  };

  expect((await deleteForever(t.env, "legacy", change, workspaceId, await trashNonce(t.env, "legacy"))).status).toBe("deleted");
  expect(await t.one("SELECT id FROM entries WHERE id = ?", survivorId)).not.toBeNull();
  expect(deleted).not.toContain(survivorId);
  expect(present.has(survivorId)).toBe(true);
});
