import { afterEach, expect, it } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { createMember } from "../../src/lib/team-admin";
import { importExportPayload } from "../../src/entries/import";

let t: TrashEnv;
afterEach(() => t?.close());
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

it("import cannot attach an edge to another member's private entry and expose its id in export", async () => {
  t = await makeTrashEnv();
  const { member: bob } = await createMember(t.env, { name: "Bob" });
  t.seed("mine", { content: "owner entry" });
  t.seed("secret", { content: "Bob private entry", actor_id: bob.userId, workspace_id: bob.personalWorkspaceId });

  const summary = await importExportPayload(t.env, {
    entries: [],
    edges: [{ source_id: "mine", target_id: "secret", type: "relates_to", weight: 1,
      provenance: "explicit", created_at: 1000 }],
  }, { writeCtx: { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId } });
  const response = await worker.fetch(new Request("http://localhost/export", {
    headers: { Authorization: "Bearer test-token" },
  }), t.env, ctx);
  expect(response.status).toBe(200);
  const backup = await response.json() as { edges: { source_id: string; target_id: string }[] };

  expect(backup.edges.some(e => e.source_id === "secret" || e.target_id === "secret")).toBe(false);
  expect(summary.edges_imported).toBe(0);
});
