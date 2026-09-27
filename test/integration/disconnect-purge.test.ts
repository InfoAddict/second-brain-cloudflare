import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { loadIntegration } from "../../src/integrations";
import { runScheduledIntegrationSync } from "../../src/integrations/mirror";
import { trashMirroredEntries } from "../../src/memory/trash";
import { createMember } from "../../src/lib/team-admin";
import { DISCONNECT_PURGE_PAGE } from "../../src/constants";
import type { Identity } from "../../src/lib/identity";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let t: TrashEnv;
let fetchSpy: ReturnType<typeof vi.fn>;
afterEach(() => { t?.close(); vi.unstubAllGlobals(); });

async function connected(n: number, opts: { workspaceId?: string; actorId?: string } = {}) {
  fetchSpy = vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("/users/me")) return new Response(JSON.stringify({ object: "user", type: "bot", name: "SB", bot: { workspace_name: "Acme" } }), { status: 200 });
    return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);
  t = await makeTrashEnv();
  await worker.fetch(new Request("http://localhost/integrations/notion/connect", { method: "POST", headers, body: JSON.stringify({ token: "t" }) }), t.env, ctx);
  await t.sqlite.db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${n - 1})
    INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
    SELECT 'p' || printf('%05d', i), 'page ' || i, '["notion"]', 'notion', 1000, 1000, '[]', '${opts.workspaceId ?? t.roots.ownerPersonalWorkspaceId}', '${opts.actorId ?? t.roots.ownerUserId}' FROM n`);
  const rec = (await loadIntegration(t.env, "notion"))!;
  rec.itemMap = Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i).padStart(5, "0")}`, { entryId: `p${String(i).padStart(5, "0")}`, version: "v1" } as any]));
  await t.env.OAUTH_KV.put("integrations:notion", JSON.stringify(rec));
}
const disconnect = (body: Record<string, unknown> = { purge: true }) =>
  worker.fetch(new Request("http://localhost/integrations/notion/disconnect", { method: "POST", headers, body: JSON.stringify(body) }), t.env, ctx);
const count = async (sql: string) => ((await t.one<any>(sql))!.n as number);

describe("disconnect purge through the trash", () => {
  it("a 1,000-memory purge takes 5 calls, the first four 202 done:false with next_cursor, the last removes the connection", async () => {
    await connected(1000);
    let cursor: string | undefined;
    const calls: any[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await disconnect(cursor ? { purge: true, cursor } : { purge: true });
      calls.push({ status: res.status, body: await res.json() });
      if (calls[i].body.done) break;
      cursor = calls[i].body.next_cursor;
    }
    expect(calls.map((c) => c.status)).toEqual([202, 202, 202, 202, 200]);
    expect(calls.slice(0, 4).every((c) => c.body.done === false && typeof c.body.next_cursor === "string")).toBe(true);
    expect(calls[4].body).toMatchObject({ ok: true, done: true, purged: 1000, kept: 0 });
    expect(await count(`SELECT COUNT(*) n FROM entries WHERE source = 'notion'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) n FROM entries_trash WHERE reason = 'disconnect'`)).toBe(1000);
    expect(await loadIntegration(t.env, "notion")).toBeNull();
    await Promise.all(pending);
    expect(await count(`SELECT COUNT(*) n FROM admin_events WHERE event = 'integration_disconnected'`)).toBe(1);
    // Nothing is left to sync into or out of the connection, and the call sizes stay bounded.
    expect(DISCONNECT_PURGE_PAGE).toBe(200);
  });

  it("marks the record disconnecting on the first call and only the last call removes it", async () => {
    await connected(300);
    const first = await disconnect();
    expect(first.status).toBe(202);
    const rec = (await loadIntegration(t.env, "notion"))!;
    expect(rec.disconnecting).toEqual({ purged: 200, skipped: 0 });
    expect(await count(`SELECT COUNT(*) n FROM admin_events WHERE event = 'integration_disconnected'`)).toBe(0);
  });

  it("counts rows the caller cannot mutate, or that no longer exist, as skipped and never touches them", async () => {
    await connected(5);
    const { member } = await createMember(t.env, { name: "Ada" });
    // p00001 lives in another member's personal workspace; p00003 is gone already.
    await t.sqlite.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'p00001'`).bind(member.personalWorkspaceId, member.userId).run();
    await t.sqlite.db.prepare(`DELETE FROM entries WHERE id = 'p00003'`).run();
    const body = await (await disconnect()).json() as any;
    expect(body).toMatchObject({ done: true, purged: 3, kept: 2 });
    expect(await t.one(`SELECT id FROM entries WHERE id = 'p00001'`)).not.toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'p00001'`)).toBeNull();
  });

  it("a scheduled or manual sync skips a record marked disconnecting", async () => {
    await connected(300);
    expect((await disconnect()).status).toBe(202);
    fetchSpy.mockClear();
    await runScheduledIntegrationSync(t.env);
    expect(fetchSpy).not.toHaveBeenCalled();
    const manual = await worker.fetch(new Request("http://localhost/integrations/notion/sync", { method: "POST", headers }), t.env, ctx);
    expect(manual.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tier-2 and tier-3 memories in a chunk take the no-edges and hard-delete paths in the same batch", async () => {
    await connected(3);
    await t.sqlite.db.prepare(`UPDATE entries SET content = ? WHERE id = 'p00002'`).bind("x".repeat(20_000)).run();
    for (let i = 0; i < 200; i++) t.edge(`e${i}`, `far${i}`, "p00001");
    t.edge("edge0", "p00000", "far");
    t.version("p00002", 1);
    const batches: number[] = [];
    const real = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = (s: unknown[]) => { batches.push(s.length); return real(s as any); };
    const owner = { userId: t.roots.ownerUserId, role: "admin", personalWorkspaceId: t.roots.ownerPersonalWorkspaceId, companyWorkspaceIds: [t.roots.companyWorkspaceId] } as unknown as Identity;
    const res = await trashMirroredEntries(t.env, owner, ["p00000", "p00001", "p00002"], { provider: "notion", budget: 10_000 });
    expect(res).toEqual({ purged: 3, skipped: 0 });
    // trash tier 1 + trash tier 2 + version delete (tier 3) + edges + entries = 5 statements, then one audit batch.
    expect(batches[0]).toBe(5);
    expect((await t.one<any>(`SELECT edges_json FROM entries_trash WHERE id = 'p00000'`))!.edges_json).not.toBe("[]");
    expect((await t.one<any>(`SELECT edges_json FROM entries_trash WHERE id = 'p00001'`))!.edges_json).toBe("[]");
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'p00002'`)).toBeNull();
    expect(await count(`SELECT COUNT(*) n FROM entry_versions WHERE entry_id = 'p00002'`)).toBe(0);
    await Promise.all(pending);
    const ev = (await t.all<any>(`SELECT entry_id, payload FROM entry_events WHERE event = 'deleted' ORDER BY entry_id`)).map((e) => [e.entry_id, JSON.parse(e.payload)]);
    expect(ev.map((e) => e[0])).toEqual(["p00000", "p00001", "p00002"]);
    expect(ev[1][1]).toMatchObject({ trash: true, edgesDropped: true, reason: "disconnect" });
    expect(ev[2][1]).toMatchObject({ trash: false, tooLargeForTrash: true });
  });

  it("every trashed memory has a deleted audit row written through the chunked writer", async () => {
    await connected(120);
    const sizes: number[] = [];
    const real = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = (s: unknown[]) => { sizes.push(s.length); return real(s as any); };
    await disconnect();
    expect(await count(`SELECT COUNT(*) n FROM entry_events WHERE event = 'deleted'`)).toBe(120);
    expect(sizes.filter((n) => n >= 20)).toEqual([50, 50, 20]);
  });

  it("an interrupted purge resumes from next_cursor with nothing trashed twice", async () => {
    await connected(600);
    const first = await (await disconnect()).json() as any;
    const second = await (await disconnect({ purge: true, cursor: first.next_cursor })).json() as any;
    // The response to the second call is lost, so the client repeats it with the same cursor: the page's rows
    // are already in the trash, so they are found missing and counted skipped, never trashed or audited again.
    const repeat = await (await disconnect({ purge: true, cursor: first.next_cursor })).json() as any;
    expect(repeat).toMatchObject({ done: false, next_cursor: second.next_cursor });
    const last = await (await disconnect({ purge: true, cursor: repeat.next_cursor })).json() as any;
    expect(last).toMatchObject({ done: true });
    expect(await count(`SELECT COUNT(*) n FROM entries_trash WHERE reason = 'disconnect'`)).toBe(600);
    expect(await count(`SELECT COUNT(DISTINCT entry_id) n FROM entry_events WHERE event = 'deleted'`)).toBe(600);
    expect(await count(`SELECT COUNT(*) n FROM entry_events WHERE event = 'deleted'`)).toBe(600);
  });

  it("rejects a cursor that is not a string", async () => {
    await connected(2);
    const res = await disconnect({ purge: true, cursor: 5 });
    expect(res.status).toBe(400);
  });

  it("a disconnect without purge keeps every memory and removes the connection in one call", async () => {
    await connected(3);
    const body = await (await disconnect({})).json() as any;
    expect(body).toMatchObject({ ok: true, done: true, purged: 0, kept: 3 });
    expect(await count(`SELECT COUNT(*) n FROM entries WHERE source = 'notion'`)).toBe(3);
  });
});

describe("adversary (MINOR): a restart without a cursor must not misreport kept (ADV-trash-9)", () => {
  it("a repeated page does not report trashed memories as kept", async () => {
    await connected(300);
    const first = await (await disconnect()).json() as any;
    expect(first.done).toBe(false);
    // The dashboard reloads mid-purge and starts over without a cursor.
    const again = await (await disconnect()).json() as any;
    const last = await (await disconnect({ purge: true, cursor: again.next_cursor })).json() as any;
    expect(last.done).toBe(true);
    expect(await count(`SELECT COUNT(*) n FROM entries WHERE source = 'notion'`)).toBe(0);
    // Every memory went to the trash, so none was kept.
    expect(last).toMatchObject({ purged: 300, kept: 0 });
  });
});
