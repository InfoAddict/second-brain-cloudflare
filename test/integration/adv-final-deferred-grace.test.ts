import { afterEach, expect, it } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { revertEntry, revertedMessage } from "../../src/memory/undo";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { updateEntryContent } from "../../src/capture/store";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

it("the instructed vectorize-pending drain cannot report zero while a fresh undo row remains unindexed", async () => {
  t = await makeTrashEnv();
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;
  const merges = 26;
  t.seed("hub", { content: "hub " + "x".repeat(merges) });
  for (let i = 0; i < merges; i++) {
    t.version("hub", i + 1, {
      content: "hub " + "x".repeat(i), reason: "merge",
      meta: JSON.stringify({ incoming: `fact ${i}`, incomingTags: [], incomingSource: "api" }),
      created_at: 2000 + i,
    });
  }
  const result = await revertEntry(t.env, owner, "hub", { actorId: owner.userId, channel: "rest" },
    { ...DEFAULTS, VERSION_KEEP: 30 }, 1, owner.personalWorkspaceId);
  expect(result.status).toBe("reverted");
  if (result.status !== "reverted") return;
  expect(result.deferredIncoming).toBe(1);
  expect(revertedMessage("hub", result)).toContain("POST /vectorize-pending until remaining is 0");

  const response = await worker.fetch(new Request("http://localhost/vectorize-pending", {
    method: "POST", headers: { Authorization: "Bearer test-token" },
  }), t.env, ctx);
  expect(response.status).toBe(200);
  const data = await response.json() as { processed: number; remaining: number };
  const pending = await t.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM entries WHERE content LIKE 'fact %' AND vector_ids = '[]'",
  );
  expect(pending?.n).toBe(1);
  expect(data.remaining).toBeGreaterThan(0);
});

it("an ordinary write to a deferred row indexes it automatically, with no POST /vectorize-pending call", async () => {
  t = await makeTrashEnv();
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;
  const merges = 26;
  t.seed("hub", { content: "hub " + "x".repeat(merges) });
  for (let i = 0; i < merges; i++) {
    t.version("hub", i + 1, {
      content: "hub " + "x".repeat(i), reason: "merge",
      meta: JSON.stringify({ incoming: `fact ${i}`, incomingTags: [], incomingSource: "api" }),
      created_at: 2000 + i,
    });
  }
  const result = await revertEntry(t.env, owner, "hub", { actorId: owner.userId, channel: "rest" },
    { ...DEFAULTS, VERSION_KEEP: 30 }, 1, owner.personalWorkspaceId);
  expect(result.status).toBe("reverted");
  if (result.status !== "reverted") return;
  expect(result.deferredIncoming).toBe(1);

  const deferred = await t.one<{ id: string; workspace_id: string }>(
    "SELECT id, workspace_id FROM entries WHERE content LIKE 'fact %' AND vector_ids = '[]'",
  );
  const deferredId = deferred!.id;

  // No /vectorize-pending call anywhere in this test: an ordinary edit to the deferred row is
  // the automatic path (T-0089.1.1, adv-final MAJOR 2) — the normal write always re-embeds from
  // its current content, whatever vector_ids held before.
  const updated = await updateEntryContent(
    t.env, deferredId, "an ordinary edit, not a repair", DEFAULTS, undefined, undefined,
    { workspaceId: deferred!.workspace_id, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" },
    deferred!.workspace_id,
  );
  expect(updated.status).toBe("updated");
  const row = await t.one<{ vector_ids: string }>("SELECT vector_ids FROM entries WHERE id = ?", deferredId);
  expect(row!.vector_ids).not.toBe("[]");
});
