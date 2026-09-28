import { afterEach, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { revertEntry } from "../../src/memory/undo";
import { DEFAULTS } from "../../src/config";
import { resolveIdentityByUserId } from "../../src/lib/identity";

let t: TrashEnv;
afterEach(() => t?.close());

it("to_version at the allowed VERSION_KEEP ceiling stays within 1,000 service subrequests", async () => {
  t = await makeTrashEnv();
  const merges = 500;
  t.seed("hub", { content: "hub " + "x".repeat(merges) });
  for (let i = 0; i < merges; i++) {
    t.version("hub", i + 1, {
      content: "hub " + "x".repeat(i), reason: "merge",
      meta: JSON.stringify({ incoming: `fact ${i}`, incomingTags: [], incomingSource: "api" }),
      created_at: 2000 + i,
    });
  }
  const ai = (t.env.AI as any).run;
  const upsert = (t.env.VECTORIZE as any).upsert;
  const before = ai.mock.calls.length + upsert.mock.calls.length;
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;

  const result = await revertEntry(t.env, owner, "hub", { actorId: t.roots.ownerUserId, channel: "rest" },
    { ...DEFAULTS, VERSION_KEEP: merges }, 1, t.roots.ownerPersonalWorkspaceId);
  expect(result.status).toBe("reverted");
  // This lower bound excludes every D1 call. Workers AI and Vectorize alone must fit the limit.
  expect(ai.mock.calls.length + upsert.mock.calls.length - before).toBeLessThanOrEqual(1000);
}, 30000);
