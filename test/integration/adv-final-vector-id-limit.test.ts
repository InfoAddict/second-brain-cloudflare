import { afterEach, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { importExportPayload } from "../../src/entries/import";
import { indexPendingRow, type PendingRow } from "../../src/vectorize/pending";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

it("an imported entry with a valid 60-byte legacy id can be indexed under Vectorize's 64-byte id limit", async () => {
  t = await makeTrashEnv();
  const id = "a".repeat(60);
  const imported = await importExportPayload(t.env, {
    entries: [{ id, content: "a historical memory with a long id", source: "api", created_at: 1000 }],
  }, { writeCtx: { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId } });
  expect(imported.imported).toBe(1);
  const upsert = t.env.VECTORIZE.upsert.bind(t.env.VECTORIZE);
  (t.env.VECTORIZE as any).upsert = async (vectors: any[]) => {
    if (vectors.some(v => new TextEncoder().encode(v.id).length > 64)) throw new Error("Vectorize id exceeds 64 bytes");
    return upsert(vectors);
  };
  const row = (await t.one<PendingRow>(
    "SELECT id, content, tags, source, created_at, workspace_id, actor_id FROM entries WHERE id = ?", id))!;
  await expect(indexPendingRow(t.env, row, DEFAULTS)).resolves.toBe(true);
  const listed = (await t.one<{ vector_ids: string }>("SELECT vector_ids FROM entries WHERE id = ?", id))!;
  expect(JSON.parse(listed.vector_ids)).toHaveLength(1);
});
