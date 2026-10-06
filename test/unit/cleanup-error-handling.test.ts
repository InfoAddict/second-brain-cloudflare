/**
 * runNightlyCleanup's purge and member-removal-resume phases are each wrapped in their own
 * try/catch (src/memory/cleanup.ts) so a failure in one never stops the other or throws out of
 * the cron handler. These are QA-added tests for those three non-fatal catch branches.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeTrashEnv, seedTrashRows, type TrashEnv } from "../helpers/trash-env";
import { makeVectorizeMock } from "../helpers/make-env";
import { runNightlyCleanup } from "../../src/memory/cleanup";
import { createMember } from "../../src/lib/team-admin";

let t: TrashEnv;
afterEach(() => { t?.close(); vi.restoreAllMocks(); });

describe("runNightlyCleanup: non-fatal failures", () => {
  it("a purge read failure is caught and logged; the removal probe still runs", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 3);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const realPrepare = t.sqlite.db.prepare.bind(t.sqlite.db);
    (t.sqlite.db as any).prepare = (sql: string) => {
      if (sql.includes("FROM entries_trash t WHERE t.deleted_at")) throw new Error("purge read failed");
      return realPrepare(sql);
    };
    const result = await runNightlyCleanup(t.env);
    expect(result).toMatchObject({ purged: 0, rowsWritten: 0, removalResumed: false });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Trash purge failed"), expect.any(Error));
    // The trash rows are untouched: the failure did not partially apply.
    expect((await t.all(`SELECT id FROM entries_trash`)).length).toBe(3);
  });

  it("a Vectorize failure while completing a resumed removal is caught and logged, and the removal still finishes", async () => {
    t = await makeTrashEnv({ VECTORIZE: makeVectorizeMock({ deleteByIds: vi.fn().mockRejectedValue(new Error("vectorize down")) }) });
    const { member } = await createMember(t.env, { name: "Ada" });
    t.seed("only", { workspace_id: member.personalWorkspaceId, actor_id: member.userId, vector_ids: '["v1"]' });
    await t.sqlite.db.prepare(`UPDATE users SET removed_at = 5 WHERE id = ?`).bind(member.userId).run();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runNightlyCleanup(t.env);
    expect(result.removalResumed).toBe(true);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Vectorize deleteByIds failed"), expect.any(Error));
    // The removal itself still completed and was audited, despite the vector delete failing.
    expect(await t.one(`SELECT id FROM entries WHERE id = 'only'`)).toBeNull();
    expect(await t.one(`SELECT id FROM admin_events WHERE event = 'member_removed'`)).not.toBeNull();
  });

  it("a pending-removal probe failure is caught and logged, without disturbing a purge that ran first", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 2);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const realPrepare = t.sqlite.db.prepare.bind(t.sqlite.db);
    (t.sqlite.db as any).prepare = (sql: string) => {
      if (sql.includes("FROM memberships m")) throw new Error("probe failed");
      return realPrepare(sql);
    };
    const result = await runNightlyCleanup(t.env);
    expect(result.purged).toBe(2);
    expect(result.removalResumed).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Member removal resume failed"), expect.any(Error));
  });
});
