import { afterEach, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { runNightlyVectorizePending, VECTORIZE_PENDING_NIGHTLY_EMBEDS } from "../../src/vectorize/pending";
import { chunkText } from "../../src/text/chunk";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

it("a deferred row with fewer than 50 chunks cannot be skipped forever just for exceeding 12,000 characters", async () => {
  t = await makeTrashEnv();
  const content = "A long restored memory. ".repeat(510);
  expect(content.length).toBeGreaterThan(12_000);
  expect(chunkText(content).length).toBeLessThanOrEqual(VECTORIZE_PENDING_NIGHTLY_EMBEDS);
  t.seed("deferred-long", { content, created_at: Date.now() - 60 * 60_000, vector_ids: "[]" });

  await runNightlyVectorizePending(t.env, DEFAULTS);
  const row = await t.one<{ vector_ids: string }>("SELECT vector_ids FROM entries WHERE id = ?", "deferred-long");
  expect(JSON.parse(row!.vector_ids).length).toBeGreaterThan(0);
});
