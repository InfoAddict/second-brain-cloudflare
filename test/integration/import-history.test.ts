import { describe, it, expect, afterEach } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { importExportPayload } from "../../src/entries/import";
import { forgetEntry } from "../../src/capture/lifecycle";
import { resolveConfig } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

const entry = (id: string, content = `imported ${id}`) => ({ id, content, tags: [], source: "api", created_at: 1000 });
const versions = async (id: string) => (await t.all<any>(`SELECT seq FROM entry_versions WHERE entry_id = ? ORDER BY seq`, id)).map((r) => r.seq);

describe("import and the trash", () => {
  it("forget, then import an old export of the same id: it is skipped as in_trash and its history is intact", async () => {
    t = await makeTrashEnv();
    t.seed("a", { content: "the newer text" }); t.version("a", 1); t.version("a", 2);
    await forgetEntry("a", t.env, { actorId: "", channel: "rest" }, { reason: "forget", config: await resolveConfig(t.env), purge: false }, t.roots.ownerPersonalWorkspaceId);
    const summary = await importExportPayload(t.env, { entries: [entry("a", "old text")] }, {});
    expect(summary).toMatchObject({ imported: 0, skipped: 1, skipped_in_trash: 1 });
    expect(summary.results).toEqual([{ id: "a", status: "skipped", reason: "in_trash" }]);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).toBeNull();
    expect((await t.one<any>(`SELECT content FROM entries_trash WHERE id = 'a'`))!.content).toBe("the newer text");
    expect(await versions("a")).toEqual([1, 2]);
  });

  it("deletes orphan versions in the insert batch; the imported row has empty history", async () => {
    t = await makeTrashEnv();
    t.version("ghost", 1); t.version("ghost", 2);
    t.version("keep", 1);
    const summary = await importExportPayload(t.env, { entries: [entry("ghost")] }, {});
    expect(summary.imported).toBe(1);
    expect(await versions("ghost")).toEqual([]);
    expect(await versions("keep")).toEqual([1]);
  });

  it("into workspace B never exposes workspace A's versions", async () => {
    t = await makeTrashEnv();
    t.version("x", 1, { workspace_id: "workspace-a", content: "A's private text" });
    const wsB = t.roots.companyWorkspaceId;
    await importExportPayload(t.env, { entries: [entry("x")] }, { writeCtx: { workspaceId: wsB, actorId: t.roots.ownerUserId } });
    expect(await t.all(`SELECT id FROM entry_versions WHERE content = 'A''s private text'`)).toHaveLength(0);
    expect((await t.one<any>(`SELECT workspace_id FROM entries WHERE id = 'x'`))!.workspace_id).toBe(wsB);
  });

  it("when the insert batch fails, the per-row fallback also deletes that row's orphan versions", async () => {
    t = await makeTrashEnv();
    t.version("r1", 1); t.version("r2", 1);
    const real = t.sqlite.db.batch.bind(t.sqlite.db);
    let failed = false;
    (t.sqlite.db as any).batch = (stmts: unknown[]) => {
      if (!failed && stmts.length > 2) { failed = true; return Promise.reject(new Error("batch down")); }
      return real(stmts as any);
    };
    const summary = await importExportPayload(t.env, { entries: [entry("r1"), entry("r2")] }, {});
    expect(failed).toBe(true);
    expect(summary.imported).toBe(2);
    expect(await versions("r1")).toEqual([]);
    expect(await versions("r2")).toEqual([]);
  });
});
