import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { makeVectorizeMock } from "../helpers/make-env";
import { forgetEntry } from "../../src/capture/lifecycle";
import { resolveConfig } from "../../src/config";
import { createMember } from "../../src/lib/team-admin";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let t: TrashEnv;
afterEach(() => t?.close());

const post = (body: unknown) =>
  worker.fetch(new Request("http://localhost/forget", { method: "POST", headers, body: JSON.stringify(body) }), t.env, ctx);
const forget = async (id: string) => forgetEntry(id, t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: await resolveConfig(t.env), purge: false });
const count = async (sql: string, ...a: unknown[]) => ((await t.one<any>(sql, ...a))!.n as number);

describe("Delete forever", () => {
  it("of a live memory removes the row, edges, all versions and any trash row, then the vectors", async () => {
    const deleteByIds = vi.fn().mockResolvedValue({});
    t = await makeTrashEnv({ VECTORIZE: makeVectorizeMock({ deleteByIds }) });
    t.seed("a", { vector_ids: '["v1"]' }); t.seed("b");
    t.edge("e1", "a", "b"); t.version("a", 1); t.version("a", 2);
    const res = await post({ id: "a", permanent: true, confirm: "a" });
    const data = await res.json() as any;
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, id: "a", permanent: true, from: "live", deletedVectors: 1 });
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).toBeNull();
    expect(await t.all(`SELECT id FROM edges`)).toHaveLength(0);
    expect(await count(`SELECT COUNT(*) n FROM entry_versions WHERE entry_id = 'a'`)).toBe(0);
    expect(deleteByIds).toHaveBeenCalledWith(["v1"]);
  });

  it("of a trashed memory removes the trash row and all versions", async () => {
    t = await makeTrashEnv();
    t.seed("a"); t.version("a", 1);
    await forget("a");
    const res = await post({ id: "a", permanent: true, confirm: "a" });
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: true, from: "trash" });
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'a'`)).toBeNull();
    expect(await count(`SELECT COUNT(*) n FROM entry_versions WHERE entry_id = 'a'`)).toBe(0);
  });

  it("a missing or mismatched confirm is 400 and changes nothing", async () => {
    t = await makeTrashEnv();
    t.seed("a");
    for (const body of [{ id: "a", permanent: true }, { id: "a", permanent: true, confirm: "b" }, { id: "a", permanent: true, confirm: "" }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).not.toBeNull();
  });

  it.each([["true"], [1], [false], [null]])("permanent other than the boolean true (%j) is 400 and changes nothing", async (value) => {
    t = await makeTrashEnv();
    t.seed("a");
    const res = await post({ id: "a", permanent: value, confirm: "a" });
    expect(res.status).toBe(400);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).not.toBeNull();
  });

  it("a forget that commits just before the permanent batch still reports deleted, from trash, and leaves nothing behind", async () => {
    t = await makeTrashEnv();
    t.seed("a");
    // getReadableEntry sees it live; a racing forget wins before the permanent batch runs.
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    let first = true;
    (t.sqlite.db as any).batch = async (stmts: unknown[]) => {
      if (first && stmts.length === 5) { first = false; await forget("a"); }
      return realBatch(stmts as any);
    };
    const res = await post({ id: "a", permanent: true, confirm: "a" });
    const data = await res.json() as any;
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, from: "trash" });
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'a'`)).toBeNull();
  });

  it("the purged audit row is written in the same batch, and no audit row is written when nothing was deleted", async () => {
    t = await makeTrashEnv();
    t.seed("a");
    await post({ id: "a", permanent: true, confirm: "a" });
    const ev = await t.one<any>(`SELECT payload FROM entry_events WHERE entry_id = 'a' AND event = 'purged'`);
    expect(JSON.parse(ev!.payload)).toMatchObject({ reason: "permanent", channel: "rest", from: "live" });
    // A second call: nothing left to delete, so no second purged row.
    const res2 = await post({ id: "a", permanent: true, confirm: "a" });
    expect(res2.status).toBe(404);
    expect(await count(`SELECT COUNT(*) n FROM entry_events WHERE event = 'purged'`)).toBe(1);
  });

  it("writes purged with reason permanent and from trash for a trashed row", async () => {
    t = await makeTrashEnv();
    t.seed("a");
    await forget("a");
    await post({ id: "a", permanent: true, confirm: "a" });
    const ev = await t.one<any>(`SELECT payload FROM entry_events WHERE entry_id = 'a' AND event = 'purged'`);
    expect(JSON.parse(ev!.payload)).toMatchObject({ reason: "permanent", channel: "rest", from: "trash" });
  });

  it("is scoped and author-guarded like forget: a teammate on a company memory gets 403, and cannot reach another member's own trash", async () => {
    t = await makeTrashEnv();
    const { token } = await createMember(t.env, { name: "Ada" });
    const adaHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const postAs = (h: typeof headers, body: unknown) =>
      worker.fetch(new Request("http://localhost/forget", { method: "POST", headers: h, body: JSON.stringify(body) }), t.env, ctx);

    // A company row Ada did not write: forbidden, not deleted.
    t.seed("company-row", { workspace_id: t.roots.companyWorkspaceId, actor_id: t.roots.ownerUserId });
    const denied = await postAs(adaHeaders, { id: "company-row", permanent: true, confirm: "company-row" });
    expect(denied.status).toBe(403);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'company-row'`)).not.toBeNull();

    // The owner's own trashed memory: outside Ada's readable scope entirely, so it 404s rather than 403 (never leaks that it exists).
    t.seed("owner-private");
    await forget("owner-private");
    const unreachable = await postAs(adaHeaders, { id: "owner-private", permanent: true, confirm: "owner-private" });
    expect(unreachable.status).toBe(404);
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'owner-private'`)).not.toBeNull();
  });

  it("a digest built from the memory keeps its own text", async () => {
    t = await makeTrashEnv();
    t.seed("src");
    await t.sqlite.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES ('digest1', 'the digest text stands on its own', '["digest"]', 'system', 1, 1, '[]', ?, '')`).bind(t.roots.ownerPersonalWorkspaceId).run();
    await post({ id: "src", permanent: true, confirm: "src" });
    expect((await t.one<any>(`SELECT content FROM entries WHERE id = 'digest1'`))!.content).toBe("the digest text stands on its own");
  });

  it("an unknown id is 404", async () => {
    t = await makeTrashEnv();
    const res = await post({ id: "nope", permanent: true, confirm: "nope" });
    expect(res.status).toBe(404);
  });

});

async function withMcp(env: any, run: (client: any) => Promise<void>) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { buildMcpServer } = await import("../../src/mcp/server");
  const server = buildMcpServer(env, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try { await run(client); } finally { await client.close(); }
}

describe("Delete forever is not offered over MCP", () => {
  it("forget's input schema has no permanent or confirm parameter", async () => {
    const { makeTestEnv, makeTestDb } = await import("../helpers/make-env");
    const env = makeTestEnv(makeTestDb());
    let schema: any;
    await withMcp(env, async (client) => {
      const { tools } = await client.listTools();
      schema = tools.find((tool: any) => tool.name === "forget")?.inputSchema ?? {};
    });
    expect(schema.properties).not.toHaveProperty("permanent");
    expect(schema.properties).not.toHaveProperty("confirm");
  });

  it("calling forget with permanent:true still just trashes it (the MCP SDK drops the unknown key)", async () => {
    const { makeTestEnv, makeTestDb } = await import("../helpers/make-env");
    const db = makeTestDb();
    db.entries.push({ id: "mcp-a", content: "c", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" });
    const env = makeTestEnv(db);
    await withMcp(env, async (client) => {
      const res = await client.callTool({ name: "forget", arguments: { id: "mcp-a", permanent: true } });
      expect(String((res.content as any)[0]?.text ?? "")).toMatch(/trash/i);
    });
    expect(db.entries.find((e: any) => e.id === "mcp-a")).toBeUndefined();
    expect(db.trash.find((e: any) => e.id === "mcp-a")).toBeTruthy();
  });
});
