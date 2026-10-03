import { afterEach, expect, it } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";

let t: TrashEnv;
afterEach(() => t?.close());

it("the scheduled maintenance path eventually indexes an eligible deferred memory", async () => {
  t = await makeTrashEnv();
  t.seed("deferred", {
    content: "A restored fact awaiting semantic indexing",
    created_at: Date.now() - 10 * 60_000,
    vector_ids: "[]",
  });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
  await worker.scheduled({ cron: "0 1 * * *", scheduledTime: Date.now() } as ScheduledEvent, t.env, ctx);
  await Promise.all(pending);

  const row = await t.one<{ vector_ids: string }>("SELECT vector_ids FROM entries WHERE id = ?", "deferred");
  expect(JSON.parse(row!.vector_ids)).not.toHaveLength(0);
}, 30000);
