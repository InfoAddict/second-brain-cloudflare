/**
 * M1 (dense placeholder numbering): D1 rejects a statement whose numbered placeholders have gaps
 * ("Wrong number of parameter bindings"), while node:sqlite silently accepts them. Every generated
 * statement in src/memory/trash.ts and src/memory/params.ts allocates through Params, so its
 * placeholders always run ?1..?n with n === bindings.length.
 *
 * Builder A's Task 2 owns the shared versions.ts builders and the canonical name for this file;
 * this covers builder B's own builders (trash, purge, disconnect purge, restore, Delete forever)
 * pending that merge — see the builder report for the difference from the spec's single shared file.
 */
import { describe, it, expect } from "vitest";
import { Params } from "../../src/memory/params";
import { planTrash, trashManyStatements, purgeTrash } from "../../src/memory/trash";
import { captureEnv, assertDenseParams } from "../helpers/dense-params";

describe("Params", () => {
  it("numbers the first distinct value ?1, the next ?2, and reuses a repeated value's number", () => {
    const p = new Params();
    expect(p.add("a")).toBe("?1");
    expect(p.add("b")).toBe("?2");
    expect(p.add("a")).toBe("?1");
    expect(p.add("c")).toBe("?3");
    expect(p.values()).toEqual(["a", "b", "c"]);
  });
});

describe("trashManyStatements: every builder is dense", () => {
  const change = { actorId: "u", channel: "rest" as const };

  it("tier 1 (with edges)", () => {
    const { env, calls } = captureEnv();
    const plan = planTrash([{ id: "a", workspace_id: "", actor_id: "", vector_ids: "[]", content_bytes: 10, row_json_bytes: 10, edges_json_bytes: 10 }]);
    trashManyStatements(env, plan, { reason: "forget", change, now: 1 });
    for (const c of calls) assertDenseParams(c.sql, c.args);
  });

  it("tier 2 (without edges)", () => {
    const { env, calls } = captureEnv();
    const plan = planTrash([{ id: "a", workspace_id: "", actor_id: "", vector_ids: "[]", content_bytes: 10, row_json_bytes: 10, edges_json_bytes: 2_000_000 }]);
    trashManyStatements(env, plan, { reason: "disconnect", change, now: 1 });
    for (const c of calls) assertDenseParams(c.sql, c.args);
  });

  it("tier 3 (hard delete, extra version-delete statement)", () => {
    const { env, calls } = captureEnv();
    const plan = planTrash([{ id: "a", workspace_id: "", actor_id: "", vector_ids: "[]", content_bytes: 2_000_000, row_json_bytes: 10, edges_json_bytes: 10 }]);
    trashManyStatements(env, plan, { reason: "forget", change, now: 1 });
    for (const c of calls) assertDenseParams(c.sql, c.args);
  });

  it("a mixed batch of all three tiers", () => {
    const { env, calls } = captureEnv();
    const rows = [
      { id: "a", workspace_id: "", actor_id: "", vector_ids: "[]", content_bytes: 10, row_json_bytes: 10, edges_json_bytes: 10 },
      { id: "b", workspace_id: "", actor_id: "", vector_ids: "[]", content_bytes: 10, row_json_bytes: 10, edges_json_bytes: 2_000_000 },
      { id: "c", workspace_id: "", actor_id: "", vector_ids: "[]", content_bytes: 2_000_000, row_json_bytes: 10, edges_json_bytes: 10 },
    ];
    trashManyStatements(env, planTrash(rows), { reason: "forget", change, now: 1 });
    for (const c of calls) assertDenseParams(c.sql, c.args);
  });
});

describe("purgeTrash's builders are dense", () => {
  it("the candidate read", async () => {
    const { env, calls } = captureEnv();
    await purgeTrash(env, { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 } as any, { ceiling: 10, rowTarget: 5000, now: Date.now() });
    for (const c of calls) assertDenseParams(c.sql, c.args);
  });
});

describe("restoreEntry and deleteForever builders are dense", () => {
  it("deleteForever's batch", async () => {
    const { env, calls } = captureEnv();
    const { deleteForever } = await import("../../src/memory/trash");
    await deleteForever(env, { id: "a", vector_ids: "[]" }, { actorId: "u", channel: "rest" });
    for (const c of calls) assertDenseParams(c.sql, c.args);
  });

  it("restoreEntry's batch (deprecated row, so no embed call is needed)", async () => {
    const { env, calls } = captureEnv();
    const { restoreEntry } = await import("../../src/memory/trash");
    const trashed = { id: "a", workspace_id: "", actor_id: "", content: "c", row_json: JSON.stringify({ tags: '["status:deprecated"]' }), edges_json: "[]", deleted_at: 1, reason: "forget" as const };
    await restoreEntry(env, trashed, { actorId: "u", channel: "rest" }, { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 } as any);
    for (const c of calls) assertDenseParams(c.sql, c.args);
  });
});
