/**
 * forgetEntry reports `deleted` only when its batch's entries DELETE removed a row, so two racing
 * deleters (a sync and a purge) cannot both claim, and audit, one deletion.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { forgetEntry } from "../../src/capture/lifecycle";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { makeVectorizeMock } from "../helpers/make-env";
import { resolveConfig } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

async function forget(id: string) {
  return forgetEntry(id, t.env, { actorId: "", channel: "rest" }, { reason: "forget", config: await resolveConfig(t.env), purge: false }, t.roots.ownerPersonalWorkspaceId);
}

describe("forgetEntry", () => {
  it("reports deleted when the batch removed the row", async () => {
    t = await makeTrashEnv();
    t.seed("x", { vector_ids: '["v1"]' });
    expect(await forget("x")).toEqual({ status: "deleted", vectorCount: 1, trashed: true, edgesDropped: false });
  });

  it("reports not_found, and touches no vectors, when a racing deleter got there first", async () => {
    const deleteByIds = vi.fn().mockResolvedValue({});
    t = await makeTrashEnv({ VECTORIZE: makeVectorizeMock({ deleteByIds }) });
    t.seed("x", { vector_ids: '["v1"]' });
    // The row is deleted between forget's read and its batch.
    const real = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = async (stmts: unknown[]) => {
      await t.sqlite.db.prepare(`DELETE FROM entries WHERE id = 'x'`).run();
      return real(stmts as any);
    };
    expect(await forget("x")).toEqual({ status: "not_found" });
    expect(deleteByIds).not.toHaveBeenCalled();
    // The racing deleter's row is not resurrected into the trash.
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'x'`)).toBeNull();
  });
});
