import { describe, it, expect } from "vitest";
import { canRevert } from "../../src/memory/versions";
import type { Identity } from "../../src/lib/identity";

const id = (userId: string, role: "admin" | "member" = "member"): Identity =>
  ({ userId, role, personalWorkspaceId: `p-${userId}`, companyWorkspaceIds: ["co"], defaultShare: "" });
const version = (over: Partial<{ seq: number; workspace_id: string; actor_id: string }> = {}) =>
  ({ seq: 3, workspace_id: "co", actor_id: "alice", ...over });
const companyRow = { workspace_id: "co", actor_id: "alice" };

describe("canRevert", () => {
  it("the author may revert any visible version", () => {
    expect(canRevert(id("alice"), companyRow, version({ seq: 1, actor_id: "bob" }), 3)).toEqual({ ok: true });
  });

  it("an admin may revert any visible version", () => {
    expect(canRevert(id("root", "admin"), companyRow, version({ seq: 1, actor_id: "bob" }), 3)).toEqual({ ok: true });
  });

  it("a member who dismissed a company insight may revert that dismissal", () => {
    expect(canRevert(id("bob"), { workspace_id: "co", actor_id: "" }, version({ actor_id: "bob", seq: 5 }), 5)).toEqual({ ok: true });
  });

  it("that member may not revert it once another member has changed the row since (stale)", () => {
    expect(canRevert(id("bob"), { workspace_id: "co", actor_id: "" }, version({ actor_id: "bob", seq: 5 }), 6)).toEqual({ ok: false, code: "stale" });
  });

  it("a member may not revert another member's change on a company row (forbidden)", () => {
    expect(canRevert(id("bob"), companyRow, version({ actor_id: "carol", seq: 5 }), 5)).toEqual({ ok: false, code: "forbidden" });
  });

  it("a member may redo: revert their own revert", () => {
    expect(canRevert(id("bob"), companyRow, version({ actor_id: "bob", seq: 7 }), 7)).toEqual({ ok: true });
  });

  it("nobody may revert a version hidden from them by D-SH (unreadable)", () => {
    expect(canRevert(id("bob"), companyRow, version({ workspace_id: "p-alice", actor_id: "bob" }), 3)).toEqual({ ok: false, code: "unreadable" });
    expect(canRevert(id("root", "admin"), companyRow, version({ workspace_id: "p-alice" }), 3)).toEqual({ ok: false, code: "unreadable" });
  });

  it("on a personal row the owner may revert anything", () => {
    const owner = id("alice");
    expect(canRevert(owner, { workspace_id: "p-alice", actor_id: "alice" }, version({ workspace_id: "p-alice", actor_id: "", seq: 1 }), 4)).toEqual({ ok: true });
  });

  it("a member whose capture merged into another member's company row may revert that merge while it is the newest version", () => {
    expect(canRevert(id("bob"), companyRow, version({ actor_id: "bob", seq: 9 }), 9)).toEqual({ ok: true });
  });

  it("a member whose capture deprecated another member's company row may revert that deprecation while it is the newest version", () => {
    expect(canRevert(id("bob"), companyRow, version({ actor_id: "bob", seq: 2 }), 2)).toEqual({ ok: true });
    expect(canRevert(id("bob"), companyRow, version({ actor_id: "bob", seq: 2 }), 3)).toEqual({ ok: false, code: "stale" });
  });

  it("a version stamped \"\" is readable only by the owner, not by another admin", () => {
    const legacy = version({ workspace_id: "", actor_id: "" });
    expect(canRevert(id("root", "admin"), companyRow, legacy, 3, { ownerUserId: "root" })).toEqual({ ok: true });
    expect(canRevert(id("other", "admin"), companyRow, legacy, 3, { ownerUserId: "root" })).toEqual({ ok: false, code: "unreadable" });
    expect(canRevert(id("other", "admin"), companyRow, legacy, 3)).toEqual({ ok: false, code: "unreadable" });
  });

  it("an identity-less caller may revert anything", () => {
    expect(canRevert(undefined, companyRow, version({ workspace_id: "" }), 3)).toEqual({ ok: true });
  });

  it("a system version (empty actor) never grants rule (b)", () => {
    expect(canRevert(id("bob"), companyRow, version({ actor_id: "" }), 3)).toEqual({ ok: false, code: "forbidden" });
  });
});
