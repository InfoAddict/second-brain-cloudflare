import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { makeVectorizeMock } from "../helpers/make-env";
import { forgetEntry } from "../../src/capture/lifecycle";
import { restoreEntry, getTrashedEntry } from "../../src/memory/trash";
import { resolveConfig } from "../../src/config";
import * as health from "../../src/vectorize/health";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let t: TrashEnv;
afterEach(() => { t?.close(); vi.restoreAllMocks(); });

const forget = async (id: string) => forgetEntry(id, t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: await resolveConfig(t.env), purge: false });

/** A Vectorize double that keeps state, so "which vectors exist" can be asserted (adversary port). */
function statefulVectorize() {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    index: {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      insert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v.metadata); return { mutationId: "m" }; }),
      upsert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v.metadata); return { mutationId: "m" }; }),
      deleteByIds: vi.fn(async (ids: string[]) => { for (const id of ids) store.delete(id); return { mutationId: "m" }; }),
      getByIds: vi.fn(async (ids: string[]) => ids.filter((id) => store.has(id)).map((id) => ({ id, metadata: store.get(id) }))),
      describe: vi.fn().mockResolvedValue({}),
    } as unknown as VectorizeIndex,
  };
}
const post = (path: string, body: unknown) =>
  worker.fetch(new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }), t.env, ctx);
const restore = async (id: string, cfgOverride?: any) => {
  const trashed = await getTrashedEntry(t.env, undefined, id);
  if (!trashed) throw new Error("not in trash");
  return restoreEntry(t.env, trashed, { actorId: "u", channel: "rest" }, cfgOverride ?? await resolveConfig(t.env));
};

describe("restore", () => {
  it("round-trips every column except vector_ids, including NULLs", async () => {
    t = await makeTrashEnv();
    t.seed("a", { recall_count: null, updated_at: null, when_at: null, importance_score: 3, tags: '["x"]', source: "voice", created_at: 555 });
    await forget("a");
    const res = await restore("a");
    expect(res.status).toBe("restored");
    const row = await t.one<any>(`SELECT * FROM entries WHERE id = 'a'`);
    expect(row).toMatchObject({ content: "content of a", tags: '["x"]', source: "voice", created_at: 555, importance_score: 3, workspace_id: t.roots.ownerPersonalWorkspaceId, actor_id: t.roots.ownerUserId });
    expect(row.recall_count).toBeNull();
    expect(row.updated_at).toBeNull();
    expect(row.when_at).toBeNull();
  });

  it("an absent key restores the column default; a stored null restores NULL", async () => {
    t = await makeTrashEnv();
    // Simulate a pre-4.0 trash row whose row_json omits recall_count (absent key) but stores when_at: null.
    t.seed("legacy");
    await forget("legacy");
    await t.sqlite.db.prepare(`UPDATE entries_trash SET row_json = json_remove(row_json, '$.recall_count') WHERE id = 'legacy'`).run();
    const res = await restore("legacy");
    expect(res.status).toBe("restored");
    const row = await t.one<any>(`SELECT recall_count, when_at FROM entries WHERE id = 'legacy'`);
    expect(row.recall_count).toBe(0);
    expect(row.when_at).toBeNull();
  });

  it("re-creates edges whose other endpoint exists, and drops the ones that don't", async () => {
    t = await makeTrashEnv();
    t.seed("a"); t.seed("b");
    t.edge("e1", "a", "b");
    await forget("a");
    expect(await t.all(`SELECT id FROM edges`)).toHaveLength(0);
    await restore("a");
    expect((await t.all(`SELECT id FROM edges`)).map((r) => r.id)).toEqual(["e1"]);

    t.seed("c"); t.edge("e2", "c", "gone");
    await forget("c");
    const res = await restore("c");
    expect(res.status).toBe("restored");
    expect((res as any).edgesRestored).toBe(0);
    expect(await t.all(`SELECT id FROM edges WHERE id = 'e2'`)).toHaveLength(0);
  });

  it("re-adds FTS and entry_counts, and bumps the capsule revision", async () => {
    t = await makeTrashEnv();
    t.seed("cap", { tags: '["capsule:core"]', content: "restoredwordforfts" });
    await forget("cap");
    const rev1 = (await t.one<any>(`SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?`, t.roots.ownerPersonalWorkspaceId))?.revision;
    await restore("cap");
    expect(await t.all(`SELECT id FROM entries_fts WHERE entries_fts MATCH '"restoredwordforfts"'`)).toHaveLength(1);
    expect((await t.one<any>(`SELECT n FROM entry_counts WHERE workspace_id = ?`, t.roots.ownerPersonalWorkspaceId))!.n).toBe(1);
    const rev2 = (await t.one<any>(`SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?`, t.roots.ownerPersonalWorkspaceId))?.revision;
    expect(rev2).not.toBe(rev1);
  });

  it("re-embeds on restore", async () => {
    const upsert = vi.fn().mockResolvedValue({ mutationId: "m" });
    t = await makeTrashEnv({ VECTORIZE: makeVectorizeMock({ upsert }) });
    t.seed("a");
    await forget("a");
    upsert.mockClear();
    const res = await restore("a");
    expect(res.status).toBe("restored");
    expect(upsert).toHaveBeenCalled();
    expect((await t.one<any>(`SELECT vector_ids FROM entries WHERE id = 'a'`))!.vector_ids).not.toBe("[]");
  });

  it("a deprecated memory is not embedded", async () => {
    const upsert = vi.fn().mockResolvedValue({ mutationId: "m" });
    t = await makeTrashEnv({ VECTORIZE: makeVectorizeMock({ upsert }) });
    t.seed("a", { tags: '["status:deprecated"]' });
    await forget("a");
    const res = await restore("a");
    expect(res.status).toBe("restored");
    expect(upsert).not.toHaveBeenCalled();
    expect((await t.one<any>(`SELECT vector_ids FROM entries WHERE id = 'a'`))!.vector_ids).toBe("[]");
  });

  it("a transient embed failure leaves it in the trash", async () => {
    t = await makeTrashEnv();
    t.seed("a");
    await forget("a");
    vi.spyOn(health, "isVectorizeUnavailable").mockResolvedValue(false);
    const real = t.env.VECTORIZE.upsert as any;
    (t.env.VECTORIZE as any).upsert = vi.fn().mockRejectedValue(new Error("down"));
    const res = await restore("a");
    expect(res.status).toBe("reembed_failed");
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'a'`)).not.toBeNull();
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).toBeNull();
    void real;
  });

  it("keyword-only restore when Vectorize is unavailable", async () => {
    t = await makeTrashEnv();
    t.seed("a");
    await forget("a");
    vi.spyOn(health, "isVectorizeUnavailable").mockResolvedValue(true);
    (t.env.VECTORIZE as any).upsert = vi.fn().mockRejectedValue(new Error("down"));
    const res = await restore("a");
    expect(res.status).toBe("restored");
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).not.toBeNull();
    expect((await t.one<any>(`SELECT vector_ids FROM entries WHERE id = 'a'`))!.vector_ids).toBe("[]");
  });

  it("a live-again id gives conflict and does not touch the live row's real (deterministic) vector", async () => {
    // Adversary finding: a vector id fabricated by the test ("live-again") can never see the bug —
    // restoreEntry's own upsert embeds under the SAME deterministic id ("a") the live row already
    // uses, so the live row's vector id must genuinely be "a" for this to prove anything.
    const vz = statefulVectorize();
    t = await makeTrashEnv({ VECTORIZE: vz.index });
    t.seed("a", { content: "original", vector_ids: '["a"]' });
    vz.store.set("a", { content: "original" });
    await forget("a");
    t.seed("a", { content: "re-captured", vector_ids: '["a"]' }); // re-captured under the same id while trashed
    vz.store.set("a", { content: "re-captured" });
    const res = await restore("a");
    expect(res.status).toBe("conflict");
    expect((await t.one<any>(`SELECT vector_ids FROM entries WHERE id = 'a'`))!.vector_ids).toBe('["a"]');
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'a'`)).not.toBeNull();
    // The live row's own vector — content "re-captured" — must survive the loser's cleanup.
    expect(vz.store.get("a")?.content).toBe("re-captured");
  });

  it("restore racing purge gives not_found and deletes only its own vectors", async () => {
    const deleteByIds = vi.fn().mockResolvedValue({});
    t = await makeTrashEnv({ VECTORIZE: makeVectorizeMock({ deleteByIds }) });
    t.seed("a");
    await forget("a");
    const trashed = await getTrashedEntry(t.env, undefined, "a");
    await t.sqlite.db.prepare(`DELETE FROM entries_trash WHERE id = 'a'`).run(); // a racing purge won
    const res = await restoreEntry(t.env, trashed!, { actorId: "u", channel: "rest" }, await resolveConfig(t.env));
    expect(res.status).toBe("not_found");
    expect(deleteByIds).toHaveBeenCalled();
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).toBeNull();
  });

  it("two concurrent restores leave the winner's vectors, and the loser reports conflict or not_found", async () => {
    const vz = statefulVectorize();
    t = await makeTrashEnv({ VECTORIZE: vz.index });
    t.seed("a", { content: "the restored memory" });
    await forget("a");
    const results = await Promise.all([restore("a"), restore("a")]);
    // The loser either raced the entries PK (conflict) or found the trash row already gone (not_found),
    // depending on exactly where the interleave landed; either way exactly one restore wins.
    expect(results.filter((r) => r.status === "restored")).toHaveLength(1);
    expect(results.filter((r) => r.status === "conflict" || r.status === "not_found")).toHaveLength(1);
    const live = await t.one<any>(`SELECT vector_ids FROM entries WHERE id = 'a'`);
    expect(live).not.toBeNull();
    // MAJOR (adversary): vector ids are deterministic (the entry id, or id-chunk-i), so the loser's
    // cleanup must not delete the SAME ids the winner just embedded.
    expect(JSON.parse(live.vector_ids)).toEqual(["a"]);
    expect(vz.store.has("a")).toBe(true);
  });

  it("MAJOR (adversary): a genuine double-submit — both restores read the trash row inside the embed's own latency window — must not delete the live row's vector", async () => {
    const vz = statefulVectorize();
    t = await makeTrashEnv({ VECTORIZE: vz.index });
    t.seed("a", { content: "the restored memory" });
    await forget("a");
    // Workers AI takes tens of milliseconds to embed: both requests read the trash row inside that window.
    const ai = t.env.AI as any;
    const run = ai.run;
    ai.run = async (...args: unknown[]) => { await new Promise((r) => setTimeout(r, 30)); return run(...args); };

    const [r1, r2] = await Promise.all([post("/restore", { id: "a" }), post("/restore", { id: "a" })]);
    expect([r1.status, r2.status].filter((s) => s === 200)).toHaveLength(1);
    const live = await t.one<any>(`SELECT vector_ids FROM entries WHERE id = 'a'`);
    expect(live).not.toBeNull();
    expect(JSON.parse(live.vector_ids)).toEqual(["a"]);
    expect(vz.store.has("a")).toBe(true);
  });

  it("MAJOR (adversary, sequential form): the loser of two restores, arriving after the winner committed, must not delete the live row's vector", async () => {
    const vz = statefulVectorize();
    t = await makeTrashEnv({ VECTORIZE: vz.index });
    t.seed("a", { content: "the restored memory" });
    await forget("a");
    const cfg = await resolveConfig(t.env);
    const staleRead = await getTrashedEntry(t.env, undefined, "a"); // both requests read the trash row
    const win = await restoreEntry(t.env, staleRead!, { actorId: "u", channel: "rest" }, cfg);
    expect(win.status).toBe("restored");
    expect(vz.store.has("a")).toBe(true);
    const lose = await restoreEntry(t.env, staleRead!, { actorId: "u", channel: "rest" }, cfg);
    // The upfront liveness check finds the winner's row and reports conflict before embedding at
    // all — the same outcome the spec asks for ("only if the id is not in entries"), reached earlier.
    expect(lose.status).toBe("conflict");
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).not.toBeNull();
    expect(vz.store.has("a")).toBe(true);
  });

  it("is scoped like forget: a teammate's company row cannot be restored by the wrong caller", async () => {
    t = await makeTrashEnv();
    const { createMember } = await import("../../src/lib/team-admin");
    const { member } = await createMember(t.env, { name: "Ada" });
    t.seed("only-mine", { workspace_id: member.personalWorkspaceId, actor_id: member.userId });
    await forget("only-mine");
    const scopedOwnerOnly = { userId: t.roots.ownerUserId, role: "member", personalWorkspaceId: t.roots.ownerPersonalWorkspaceId, companyWorkspaceIds: [] } as any;
    expect(await getTrashedEntry(t.env, scopedOwnerOnly, "only-mine")).toBeNull();
  });

  it("versions survive forget and restore, and the read rules still apply", async () => {
    t = await makeTrashEnv();
    t.seed("a"); t.version("a", 1); t.version("a", 2);
    await forget("a");
    await restore("a");
    expect((await t.all<any>(`SELECT seq FROM entry_versions WHERE entry_id = 'a' ORDER BY seq`)).map((r) => r.seq)).toEqual([1, 2]);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).not.toBeNull();
  });

  it("export includes a restored memory and excludes a trashed one", async () => {
    t = await makeTrashEnv();
    t.seed("a"); t.seed("b");
    await forget("a");
    await restore("a");
    await forget("b");
    const exp = await (await worker.fetch(new Request("http://localhost/export", { headers }), t.env, ctx)).json() as any;
    expect(exp.entries.map((e: any) => e.id)).toEqual(["a"]);
  });

});

describe("POST /restore route", () => {
  it("restores, audits and reports a friendly retention message via /forget", async () => {
    t = await makeTrashEnv();
    t.seed("a");
    await post("/forget", { id: "a" });
    const res = await post("/restore", { id: "a" });
    const data = await res.json() as any;
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, id: "a" });
    await Promise.all(pending);
    const ev = await t.one<any>(`SELECT payload FROM entry_events WHERE entry_id = 'a' AND event = 'restored'`);
    expect(JSON.parse(ev!.payload)).toMatchObject({ channel: "rest", trashedReason: "forget" });
  });

  it("404s for an id that is not in the trash", async () => {
    t = await makeTrashEnv();
    const res = await post("/restore", { id: "nope" });
    expect(res.status).toBe(404);
  });
});

describe("round 2 adversary: a slow losing restore (checklist 36g)", () => {
  it("a losing restore whose embed lands after the winner's row was edited must not leave the old text in the live vector", async () => {
    const vz = statefulVectorize();
    t = await makeTrashEnv({ VECTORIZE: vz.index });
    t.seed("a", { content: "old text from the trash" });
    await forget("a");
    const cfg = await resolveConfig(t.env);
    const stale = await getTrashedEntry(t.env, undefined, "a");

    // The loser's upsert is held until after the winner restored and the user edited the memory.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const upsert = (vz.index as any).upsert;
    let calls = 0;
    (vz.index as any).upsert = async (vs: any[]) => { if (++calls === 1) await gate; return upsert(vs); };

    const loser = restoreEntry(t.env, stale!, { actorId: "u", channel: "rest" }, cfg);
    await new Promise((r) => setTimeout(r, 20)); // the loser is past its liveness check, waiting on Vectorize
    expect((await restoreEntry(t.env, stale!, { actorId: "u", channel: "rest" }, cfg)).status).toBe("restored");
    const upd = await post("/update", { id: "a", content: "new text after restore" });
    expect(upd.status).toBe(200);
    expect(vz.store.get("a")?.content).toBe("new text after restore");
    release();
    expect(["conflict", "not_found"]).toContain((await loser).status);

    const live = await t.one<any>(`SELECT content FROM entries WHERE id = 'a'`);
    expect(live.content).toBe("new text after restore");
    expect(vz.store.get("a")?.content).toBe(live.content);
  });
});
