import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { forgetEntry } from "../../src/capture/lifecycle";
import { resolveConfig } from "../../src/config";
import { deleteForever } from "../../src/memory/trash";

// T-0089.1.1 close-out: Delete forever acts only on a trash row named by id AND its nonce. A live
// memory is forgotten into the trash first; no path authorizes Delete forever by id alone.

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let t: TrashEnv;
afterEach(() => t?.close());

const post = (body: unknown) =>
  worker.fetch(new Request("http://localhost/forget", { method: "POST", headers, body: JSON.stringify(body) }), t.env, ctx);
const forget = async (id: string) => forgetEntry(id, t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: await resolveConfig(t.env), purge: false }, t.roots.ownerPersonalWorkspaceId);
const nonceOf = async (id: string) => (await t.one<{ nonce: string }>(`SELECT nonce FROM entries_trash WHERE id = ?`, id))!.nonce;
const change = { actorId: "u", channel: "rest" as const };

describe("Delete forever is nonce-only", () => {
  it("REST refuses a live memory: no nonce is 400, any nonce is 404, and the row, versions and edges stay", async () => {
    t = await makeTrashEnv();
    t.seed("a"); t.seed("b"); t.edge("e1", "a", "b"); t.version("a", 1);
    for (const body of [
      { id: "a", permanent: true, confirm: "a" },
      { id: "a", permanent: true, confirm: "a", nonce: "" },
      { id: "a", permanent: true, confirm: "a", nonce: 7 },
    ]) expect((await post(body)).status).toBe(400);
    expect((await post({ id: "a", permanent: true, confirm: "a", nonce: "made-up" })).status).toBe(404);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).not.toBeNull();
    expect(await t.all(`SELECT id FROM edges`)).toHaveLength(1);
    expect(await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'a'`)).toHaveLength(1);
    expect(await t.all(`SELECT id FROM entry_events WHERE event = 'purged'`)).toHaveLength(0);
  });

  it("REST on a trashed memory: no nonce is 400, a wrong nonce is 404, the right nonce deletes it", async () => {
    t = await makeTrashEnv();
    t.seed("a"); t.version("a", 1);
    await forget("a");
    expect((await post({ id: "a", permanent: true, confirm: "a" })).status).toBe(400);
    expect((await post({ id: "a", permanent: true, confirm: "a", nonce: "not-its-nonce" })).status).toBe(404);
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'a'`)).not.toBeNull();

    const res = await post({ id: "a", permanent: true, confirm: "a", nonce: await nonceOf("a") });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "a", permanent: true });
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'a'`)).toBeNull();
    expect(await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'a'`)).toHaveLength(0);
    const ev = await t.one<{ payload: string }>(`SELECT payload FROM entry_events WHERE entry_id = 'a' AND event = 'purged'`);
    expect(JSON.parse(ev!.payload)).toMatchObject({ reason: "permanent", channel: "rest", from: "trash" });
  });

  it("deleteForever itself deletes nothing without a nonce, live or trashed", async () => {
    t = await makeTrashEnv();
    const ws = t.roots.ownerPersonalWorkspaceId;
    t.seed("live"); t.seed("gone"); await forget("gone");
    for (const nonce of [undefined, ""]) {
      for (const id of ["live", "gone"]) {
        const r = await deleteForever(t.env, id, change, ws, nonce as unknown as string);
        expect(r.status).not.toBe("deleted");
      }
    }
    // A live row is never deleted forever, even with the nonce of some other trash row.
    expect((await deleteForever(t.env, "live", change, ws, await nonceOf("gone"))).status).not.toBe("deleted");
    expect(await t.one(`SELECT id FROM entries WHERE id = 'live'`)).not.toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'gone'`)).not.toBeNull();
  });

  it("a trash row that coexists with a live row of the same id is deleted without touching the live row's history, edges or vectors", async () => {
    t = await makeTrashEnv();
    t.seed("x"); await forget("x");
    const nonce = await nonceOf("x");
    // Coexistence (an import racing a forget, or undo re-creating a merged id): the live row owns the id now.
    t.seed("x", { vector_ids: '["x"]' }); t.seed("y"); t.edge("e1", "x", "y"); t.version("x", 1);
    const versionsBefore = (await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'x'`)).length;
    const deleted: string[][] = [];
    (t.env.VECTORIZE as any).deleteByIds = async (ids: string[]) => { deleted.push(ids); return {}; };
    const r = await deleteForever(t.env, "x", change, t.roots.ownerPersonalWorkspaceId, nonce);
    expect(r.status).toBe("deleted");
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'x'`)).toBeNull();
    expect(await t.one(`SELECT id FROM entries WHERE id = 'x'`)).not.toBeNull();
    expect(await t.all(`SELECT id FROM edges`)).toHaveLength(1);
    expect(await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'x'`)).toHaveLength(versionsBefore);
    expect(deleted.flat()).not.toContain("x");
  });
});

// Structural: every source path that can remove a trash row either pins it by nonce or is an
// age/workspace sweep that re-checks its own criterion in the DELETE. deleteForever is called
// only from the REST route, with the nonce from the request body, and never deletes a live row.
describe("structural: no Delete forever path accepts an id without a nonce", () => {
  const SRC = join(__dirname, "../../src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
  const all = files(SRC).map((p) => ({ p: p.slice(SRC.length + 1), src: readFileSync(p, "utf8") }));

  it("deleteForever is called only by POST /forget, passing the request's nonce", () => {
    const callers = all.filter((f) => /\bdeleteForever\(/.test(f.src) && f.p !== "memory/trash.ts");
    expect(callers.map((f) => f.p)).toEqual(["routes/entries.ts"]);
    const calls = callers[0].src.match(/deleteForever\([^;]*\);/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/,\s*nonce\s*\)/);
  });

  it("deleteForever's own statements never delete a live entry and pin every trash delete to the nonce", () => {
    const trash = all.find((f) => f.p === "memory/trash.ts")!.src;
    const body = trash.slice(trash.indexOf("export async function deleteForever("));
    expect(body).not.toMatch(/DELETE FROM entries\s+WHERE/);
    for (const stmt of body.match(/DELETE FROM entries_trash[^`]*/g) ?? []) expect(stmt).toMatch(/nonce/);
    expect(body).toMatch(/nonce: string\b/);
  });

  it("every other DELETE FROM entries_trash is a nonce pin or a named criterion sweep", () => {
    const allowedSweeps = [
      /DELETE FROM entries_trash WHERE id IN \(SELECT value FROM json_each\(\$\{trashIds\}\)\) AND deleted_at < /, // retention purge
      /DELETE FROM entries_trash WHERE workspace_id = \?/, // member removal
    ];
    for (const f of all) {
      for (const stmt of f.src.match(/DELETE FROM entries_trash[^`]*/g) ?? []) {
        const ok = /nonce/.test(stmt) || allowedSweeps.some((re) => re.test(stmt));
        expect(ok, `${f.p}: ${stmt.slice(0, 120)}`).toBe(true);
      }
    }
  });

  it("the dashboard sends the nonce and the memory sheet has no Delete forever control", () => {
    const pub = join(__dirname, "../../public");
    const crud = readFileSync(join(pub, "js/memory-crud.js"), "utf8");
    expect(crud).toMatch(/permanent: true, confirm: id, nonce/);
    expect(crud).not.toMatch(/view-btn-delete-forever/);
    expect(readFileSync(join(pub, "index.html"), "utf8")).not.toMatch(/view-btn-delete-forever/);
  });
});
