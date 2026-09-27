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
const forget = async (id: string) => forgetEntry(id, t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: await resolveConfig(t.env), purge: false }, t.roots.ownerPersonalWorkspaceId);
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

  it("the purged audit row is written in the same batch, names the actor, and no audit row is written when nothing was deleted", async () => {
    t = await makeTrashEnv();
    t.seed("a");
    await post({ id: "a", permanent: true, confirm: "a" });
    const ev = await t.one<any>(`SELECT actor_id, payload FROM entry_events WHERE entry_id = 'a' AND event = 'purged'`);
    // adversary (MINOR): the audit event must name who deleted it forever, not ''.
    expect(ev!.actor_id).toBe(t.roots.ownerUserId);
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

/** A Vectorize double that keeps state, so "which vectors exist, with what text" can be asserted. */
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

describe("adversary: Delete forever racing a restore (ADV-trash-4)", () => {
  it("Delete forever of a trashed memory that a racing restore brought back leaves no vector (content) behind", async () => {
    const vz = statefulVectorize();
    t = await makeTrashEnv({ VECTORIZE: vz.index });
    t.seed("a", { content: "secret text that must be gone" });
    await forget("a");
    const cfg = await resolveConfig(t.env);

    const realBatch = t.env.DB.batch.bind(t.env.DB);
    let injected = false;
    (t.env.DB as any).batch = async (stmts: any[]) => {
      const first = String(stmts[0]?.sourceSql?.() ?? "");
      if (!injected && first.includes("'permanent'")) {
        injected = true;
        // After the route authorized the TRASH row, before its batch: a restore commits.
        const { getTrashedEntry, restoreEntry } = await import("../../src/memory/trash");
        const trashed = await getTrashedEntry(t.env, undefined, "a");
        expect((await restoreEntry(t.env, trashed!, { actorId: "u", channel: "rest" }, cfg)).status).toBe("restored");
      }
      return realBatch(stmts);
    };
    const res = await post({ id: "a", permanent: true, confirm: "a" });
    expect(res.status).toBe(200);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).toBeNull();
    // Nothing of the memory may remain: its vector metadata carries the text.
    expect([...vz.store.values()].map((m) => m.content)).not.toContain("secret text that must be gone");
  });
});

describe("adversary: Delete forever after a failed vector delete (ADV-trash-5)", () => {
  it("Delete forever from the trash removes vectors a failed forget left behind (ids are deterministic)", async () => {
    const vz = statefulVectorize();
    t = await makeTrashEnv({ VECTORIZE: vz.index });
    t.seed("a", { content: "private words", vector_ids: '["a"]' });
    vz.store.set("a", { content: "private words", parentId: "a" });
    // Forget's vector delete is non-fatal: a transient Vectorize error leaves the vector in place.
    const del = (vz.index as any).deleteByIds;
    (vz.index as any).deleteByIds = vi.fn().mockRejectedValueOnce(new Error("vectorize 503"));
    expect((await post({ id: "a" })).status).toBe(200);
    (vz.index as any).deleteByIds = del;
    expect(vz.store.has("a")).toBe(true);

    expect((await post({ id: "a", permanent: true, confirm: "a" })).status).toBe(200);
    expect(vz.store.has("a")).toBe(false);
  });

  it("derives the chunk count from the trashed row's own content and source, deleting every chunk", async () => {
    const vz = statefulVectorize();
    t = await makeTrashEnv({ VECTORIZE: vz.index });
    // A long, non-mirrored memory: storeEntry would have chunked this into more than one vector.
    const long = "word ".repeat(20_000);
    t.seed("a", { content: long, source: "api", vector_ids: '["a-chunk-0","a-chunk-1"]' });
    vz.store.set("a-chunk-0", { content: long.slice(0, 100) });
    vz.store.set("a-chunk-1", { content: long.slice(100, 200) });
    // The forget's own vector delete fails (transient), same as the test above: the chunks survive
    // into the trash, so Delete forever is the only thing that can still remove them.
    const del = (vz.index as any).deleteByIds;
    (vz.index as any).deleteByIds = vi.fn().mockRejectedValueOnce(new Error("vectorize 503"));
    expect((await post({ id: "a" })).status).toBe(200);
    (vz.index as any).deleteByIds = del;
    expect(vz.store.has("a-chunk-0")).toBe(true);
    expect(vz.store.has("a-chunk-1")).toBe(true);

    expect((await post({ id: "a", permanent: true, confirm: "a" })).status).toBe(200);
    expect(vz.store.has("a-chunk-0")).toBe(false);
    expect(vz.store.has("a-chunk-1")).toBe(false);
  });
});

describe("round 2 adversary: Delete forever from the trash after a failed forget vector delete", () => {
  it("removes the vector a short append added (id-update-<ts>), which chunk recomputation cannot derive", async () => {
    const vz = statefulVectorize();
    t = await makeTrashEnv({ VECTORIZE: vz.index });
    const cap = await (await worker.fetch(new Request("http://localhost/capture", { method: "POST", headers, body: JSON.stringify({ content: "base memory text" }) }), t.env, ctx)).json() as any;
    const id = cap.id as string;
    expect(id).toBeTruthy();
    const append = await worker.fetch(new Request("http://localhost/append", { method: "POST", headers, body: JSON.stringify({ id, addition: "the private addition" }) }), t.env, ctx);
    expect(append.status).toBe(200);
    const ids = JSON.parse((await t.one<any>(`SELECT vector_ids FROM entries WHERE id = ?`, id))!.vector_ids) as string[];
    expect(ids.some((v) => v.startsWith(`${id}-update-`))).toBe(true);

    // Forget's Vectorize delete fails (non-fatal): every vector stays in the index, but the
    // trash row now carries this entry's real ids (round 2 fix), not just what content derives.
    const del = (vz.index as any).deleteByIds;
    (vz.index as any).deleteByIds = vi.fn().mockRejectedValueOnce(new Error("vectorize 503"));
    expect((await post({ id })).status).toBe(200);
    (vz.index as any).deleteByIds = del;

    expect((await post({ id, permanent: true, confirm: id })).status).toBe(200);
    const leftovers = [...vz.store.entries()].filter(([, m]) => m.parentId === id).map(([k, m]) => `${k}: ${m.content}`);
    expect(leftovers).toEqual([]);
  });
});

/** Runs `mutate` (awaited) right after the FIRST read matching `pattern` returns. */
function afterFirstRead(base: any, pattern: RegExp, mutate: () => Promise<void>) {
  const raw = base.DB as any;
  let fired = false;
  return { ...base, DB: { ...raw, prepare(sql: string) {
    const st = raw.prepare(sql);
    if (fired || !pattern.test(sql)) return st;
    return { bind: (...a: unknown[]) => ({ first: async () => {
      const r = await st.bind(...a).first();
      fired = true;
      await mutate();
      return r;
    } }) };
  } } };
}

describe("round 3 adversary (MAJOR): Delete forever destroys a memory that moved out of the caller's scope after its check (R3-1)", () => {
  it("an admin's Delete forever does not delete Bob's memory after Bob unshares it", async () => {
    t = await makeTrashEnv();
    const adminTok = (await createMember(t.env, { name: "Ada", role: "admin" })).token;
    const { token: bobTok, member: bob } = await createMember(t.env, { name: "Bob" });
    t.seed("x1", { content: "Bob's note", workspace_id: t.roots.companyWorkspaceId, actor_id: bob.userId });
    const racing = afterFirstRead(t.env, /^SELECT id, workspace_id, actor_id FROM entries WHERE id = \? AND/, async () => {
      await t.sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'x1'`).bind(bob.personalWorkspaceId).run();
    });
    const res = await worker.fetch(new Request("http://localhost/forget", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminTok}` },
      body: JSON.stringify({ id: "x1", permanent: true, confirm: "x1" }),
    }), racing, ctx);
    const row = await t.one<any>(`SELECT workspace_id FROM entries WHERE id = 'x1'`);
    // The race must have fired — otherwise this test proves nothing.
    expect(row?.workspace_id).toBe(bob.personalWorkspaceId);
    expect(res.status).not.toBe(200);
    void bobTok;
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
    const { ensureTenantBootstrap } = await import("../../src/lib/tenancy");
    const db = makeTestDb();
    const env = makeTestEnv(db);
    // Seeded with the owner's own workspace, resolved up front: production's ensureDbReady backfills
    // workspace_id once at cold start, well before any request, so a row this double models as
    // already on a bootstrapped brain must not depend on this test's own read timing to pick it up.
    const roots = await ensureTenantBootstrap(env);
    db.entries.push({ id: "mcp-a", content: "c", tags: "[]", source: "api", created_at: 1, vector_ids: "[]", workspace_id: roots.ownerPersonalWorkspaceId, actor_id: roots.ownerUserId });
    await withMcp(env, async (client) => {
      const res = await client.callTool({ name: "forget", arguments: { id: "mcp-a", permanent: true } });
      expect(String((res.content as any)[0]?.text ?? "")).toMatch(/trash/i);
    });
    expect(db.entries.find((e: any) => e.id === "mcp-a")).toBeUndefined();
    expect(db.trash.find((e: any) => e.id === "mcp-a")).toBeTruthy();
  });
});
