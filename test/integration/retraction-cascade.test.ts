/**
 * Track 2 Task A6 (T-0089.2.4, D2.4): retracting a memory flags what was built on it (never blocks):
 * insights drawn from it, memories caused by it, and the digest its [Digest: id] marker names. System
 * derived dependents are demoted to draft; user memories only get the flag. Undo clears it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { applyStatus, forgetEntry } from "../../src/capture/lifecycle";
import { resolveEntryAction } from "../../src/memory/actions";
import { getTrashedEntry, restoreEntry, trashMirroredEntries } from "../../src/memory/trash";
import { revertEntry } from "../../src/memory/undo";
import { applyTagReplacement, isWorkerOwnedTag } from "../../src/tags/system";
import { RETRACTED_SOURCE_TAG } from "../../src/memory/validity";
import { DEFAULTS } from "../../src/config";
import type { Identity } from "../../src/lib/identity";

let t: TrashEnv;
afterEach(() => t?.close());

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const change = () => ({ actorId: t.roots.ownerUserId, channel: "rest" as const });
const owner = (): Identity => ({
  userId: t.roots.ownerUserId, role: "admin", personalWorkspaceId: t.roots.ownerPersonalWorkspaceId,
  companyWorkspaceIds: [t.roots.companyWorkspaceId], defaultShare: "",
});
const ws = () => t.roots.ownerPersonalWorkspaceId;
const tagsOf = async (id: string) => JSON.parse((await t.one<any>(`SELECT tags FROM entries WHERE id = ?`, id))!.tags) as string[];
const versions = async (id: string) => t.all<any>(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`, id);
const link = (source: string, target: string, type: string, workspaceId = ws()) =>
  t.sqlite.db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES (?, ?, ?, ?, 1, 'system', '{}', 1, 1, ?)`)
    .bind(`${source}-${type}-${target}`, source, target, type, workspaceId).run();
const wrong = (id = "src") => applyStatus(id, "deprecated", t.env, change(), DEFAULTS, ws());
const undo = (id = "src") => revertEntry(t.env, owner(), id, change(), DEFAULTS, undefined, ws());

/** 02's fixture: an insight with 3 drawn_from sources, a memory caused by `src`, and a digest named in src's marker. */
async function fixture() {
  t = await makeTrashEnv();
  t.seed("src", { content: "Pricing is 10 dollars\n\n[Digest: dig]", tags: '["rolled-up"]' });
  t.seed("s2");
  t.seed("s3");
  t.seed("insight", { tags: '["auto-insight"]', source: "system", actor_id: "" });
  t.seed("dig", { tags: '["synthesized","status:canonical"]', source: "system", actor_id: "" });
  t.seed("plan", { tags: '["status:canonical"]' });
  for (const s of ["src", "s2", "s3"]) await link("insight", s, "drawn_from");
  await link("plan", "src", "caused_by");
}

describe("the retraction cascade", () => {
  it("deprecating a source flags insights drawn from it, memories caused by it, and its digest", async () => {
    await fixture();
    const r = await wrong();
    expect(r).toMatchObject({ status: "ok", validity: { flagged: 3 } });
    for (const id of ["insight", "dig", "plan"]) expect(await tagsOf(id), id).toContain(RETRACTED_SOURCE_TAG);
    const [v] = (await versions("insight")).slice(-1);
    expect(v).toMatchObject({ reason: "status" });
    expect(JSON.parse(v.meta)).toMatchObject({ cause: "retraction", retracted: "src" });
    const events = await t.all<any>(`SELECT payload FROM entry_events WHERE entry_id = 'insight' AND event = 'flagged'`);
    expect(JSON.parse(events[0].payload)).toMatchObject({ cause: "retraction", retracted: "src" });
  });

  it("system-derived non-canonical dependents are demoted to draft; user dependents and canonical digests keep their status", async () => {
    await fixture();
    await wrong();
    expect(await tagsOf("insight")).toContain("status:draft");
    expect(await tagsOf("dig")).toContain("status:canonical");
    expect(await tagsOf("plan")).toContain("status:canonical");
  });

  it("at most 25 dependents, one hop, same workspace", async () => {
    t = await makeTrashEnv();
    t.seed("src");
    for (let i = 0; i < 30; i++) { t.seed(`d${i}`); await link(`d${i}`, "src", "caused_by"); }
    t.seed("hop2"); await link("hop2", "d0", "caused_by");
    t.seed("other", { workspace_id: t.roots.companyWorkspaceId }); await link("other", "src", "caused_by", t.roots.companyWorkspaceId);
    const r = await wrong();
    expect(r).toMatchObject({ validity: { flagged: 25 } });
    const flagged = await t.all<any>(`SELECT id FROM entries WHERE tags LIKE '%"retracted-source"%'`);
    expect(flagged).toHaveLength(25);
    expect(await tagsOf("hop2")).not.toContain(RETRACTED_SOURCE_TAG);
    expect(await tagsOf("other")).not.toContain(RETRACTED_SOURCE_TAG);
  });

  it("forgetting the source flags too; the bulk paths (mirror, disconnect) do not cascade", async () => {
    await fixture();
    const f = await forgetEntry("src", t.env, change(), { reason: "forget", config: DEFAULTS, purge: false }, ws());
    expect(f).toMatchObject({ status: "deleted", validity: { flagged: 3 } });
    t.close();

    await fixture();
    await forgetEntry("src", t.env, change(), { reason: "mirror", config: DEFAULTS, purge: false }, ws());
    expect(await tagsOf("insight")).not.toContain(RETRACTED_SOURCE_TAG);
    t.close();

    await fixture();
    await trashMirroredEntries(t.env, owner(), ["src"], { provider: "notion" });
    expect(await tagsOf("insight")).not.toContain(RETRACTED_SOURCE_TAG);
  });

  it("undoing the retraction unflags and restores the prior status", async () => {
    await fixture();
    await wrong();
    const u = await undo();
    expect(u).toMatchObject({ status: "reverted", validity: { unflagged: 3 } });
    for (const id of ["insight", "dig", "plan"]) expect(await tagsOf(id), id).not.toContain(RETRACTED_SOURCE_TAG);
    expect(await tagsOf("insight")).not.toContain("status:draft");
    expect(await tagsOf("plan")).toContain("status:canonical");
  });

  it("restoring a forgotten source from the trash unflags", async () => {
    await fixture();
    await forgetEntry("src", t.env, change(), { reason: "forget", config: DEFAULTS, purge: false }, ws());
    const trashed = (await getTrashedEntry(t.env, undefined, "src"))!;
    const r = await restoreEntry(t.env, trashed, change(), DEFAULTS);
    expect(r).toMatchObject({ status: "restored", validity: { unflagged: 3 } });
    expect(await tagsOf("insight")).not.toContain(RETRACTED_SOURCE_TAG);
  });

  it("a dependent with a second retracted source keeps the marker until both are undone", async () => {
    await fixture();
    await wrong("src");
    await wrong("s2");
    await undo("src");
    expect(await tagsOf("insight")).toContain(RETRACTED_SOURCE_TAG);
    await undo("s2");
    expect(await tagsOf("insight")).not.toContain(RETRACTED_SOURCE_TAG);
  });

  it("a dependent whose cascade versions were pruned keeps the marker", async () => {
    await fixture();
    await wrong();
    await t.sqlite.db.prepare(`DELETE FROM entry_versions WHERE entry_id = 'insight'`).run();
    await t.sqlite.db.prepare(`INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at) VALUES ('insight', ?, 7, 'x', NULL, '[]', '', 'rest', 'update', 5)`).bind(ws()).run();
    await undo();
    expect(await tagsOf("insight")).toContain(RETRACTED_SOURCE_TAG);
  });

  it("a hand-written [Digest: id] marker does not reach a memory that is not a digest", async () => {
    t = await makeTrashEnv();
    t.seed("victim", { content: "My own note" });
    t.seed("forged", { content: "Nothing to see [Digest: victim]" });
    const r = await wrong("forged");
    expect(r).toMatchObject({ validity: { flagged: 0 } });
    expect(await tagsOf("victim")).not.toContain(RETRACTED_SOURCE_TAG);
  });

  it("retracting twice flags once", async () => {
    await fixture();
    await wrong();
    const n = (await versions("insight")).length;
    const again = await wrong();
    expect(again).toMatchObject({ validity: { flagged: 0 } });
    expect(await versions("insight")).toHaveLength(n);
  });

  it("Keep in the stale review clears retracted-source", async () => {
    await fixture();
    await wrong();
    const r = await resolveEntryAction(t.env, ctx, owner(), "plan", "still_true", undefined, change());
    expect(r).toMatchObject({ ok: true });
    expect(await tagsOf("plan")).not.toContain(RETRACTED_SOURCE_TAG);
  });

  it("retracted-source is a system tag: an edit cannot remove it", () => {
    expect(isWorkerOwnedTag(RETRACTED_SOURCE_TAG)).toBe(true);
    expect(applyTagReplacement(["work", RETRACTED_SOURCE_TAG], ["home"])).toEqual([RETRACTED_SOURCE_TAG, "home"]);
  });
});
