/**
 * Task 15 (T-0089.6.6): POST /undo and the MCP undo tool over revertEntry. Both surfaces share
 * one domain call, so these exercise every revertEntry result through each surface and assert the
 * status/body (REST) or sentence (MCP) the spec's table gives, plus the parity and audit rules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { updateEntryContent } from "../../src/capture/store";
import { forgetEntry } from "../../src/capture/lifecycle";
import { buildMcpServer } from "../../src/mcp/server";
import worker from "../../src/index";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(), AI: makeAIMock() });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  id, over.content ?? "text", JSON.stringify(over.tags ?? []), over.source ?? "api", over.createdAt ?? 1000, over.updatedAt ?? null,
  JSON.stringify(over.vectorIds ?? [id]), over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId,
).run();
const row = (id: string) => sqlite.rows().find((r: any) => r.id === id) as any;
const versions = async (id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const events = async (id: string) => (await env.DB.prepare(`SELECT event, payload FROM entry_events WHERE entry_id = ? ORDER BY rowid`).bind(id).all()).results as any[];

const restUndo = (id: string, toVersion?: number, token = "test-token") =>
  worker.fetch(new Request("http://localhost/undo", {
    method: "POST", headers: { ...headers, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, ...(toVersion !== undefined ? { to_version: toVersion } : {}) }),
  }), env, ctx);

async function mcpUndo(identity: Identity, id: string, toVersion?: number) {
  const server = buildMcpServer(env, ctx, identity);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: "undo", arguments: { id, ...(toVersion !== undefined ? { to_version: toVersion } : {}) } });
    return (result.content as { type: string; text: string }[])[0]?.text ?? "";
  } finally {
    await client.close();
  }
}

describe("POST /undo maps every revertEntry result to its status and body", () => {
  it("reverted: 200, with targetSeq", async () => {
    seed("u1", { content: "before" });
    await updateEntryContent(env, "u1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    const res = await restUndo("u1");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, id: "u1", status: "reverted", targetSeq: 1 });
    expect(row("u1").content).toBe("before");
  });

  it("restored: 200", async () => {
    seed("t1", { content: "keep me" });
    await forgetEntry("t1", env, { actorId: owner.userId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
    const res = await restUndo("t1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "t1", status: "restored" });
    expect(row("t1").content).toBe("keep me");
  });

  it("no_change: 200 with changed:false, and nothing is written", async () => {
    seed("nc1", { content: "same", tags: ["a"] });
    await updateEntryContent(env, "nc1", "changed", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    await updateEntryContent(env, "nc1", "same", DEFAULTS, undefined, ["a"], { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    const before = await versions("nc1");
    const res = await restUndo("nc1", before[0].seq);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "nc1", status: "no_change", changed: false });
    expect(await versions("nc1")).toEqual(before);
  });

  it("nothing_to_undo: 409, and nothing is written", async () => {
    seed("empty1");
    const res = await restUndo("empty1");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(await versions("empty1")).toEqual([]);
  });

  it("not_found: 404, the same text GET /entry would give for a missing id", async () => {
    const res = await restUndo("nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "No entry found with ID: nope" });
  });

  it("forbidden: 403, the author-lock message, and nothing is written", async () => {
    const roots = await ensureTenantBootstrap(env);
    const { token: bobToken, member: bob } = await createMember(env, { name: "Bob" });
    seed("cf1", { content: "before", workspaceId: roots.companyWorkspaceId, actorId: owner.userId });
    await updateEntryContent(env, "cf1", "after", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, roots.companyWorkspaceId);
    const res = await restUndo("cf1", undefined, bobToken);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "Only the entry's author or an admin can modify a shared company memory" });
    expect(row("cf1").content).toBe("after");
    void bob;
  });

  it("unreadable: 404, indistinguishable from not_found (a hidden version cannot be the target)", async () => {
    const roots = await ensureTenantBootstrap(env);
    const { token: bobToken } = await createMember(env, { name: "Bob" });
    seed("h1", { content: "personal v1", workspaceId: owner.personalWorkspaceId });
    await updateEntryContent(env, "h1", "personal v2", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    const preShareSeq = (await versions("h1"))[0].seq;
    sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'h1'`).bind(roots.companyWorkspaceId).run();
    await updateEntryContent(env, "h1", "company v3", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, roots.companyWorkspaceId);
    const res = await restUndo("h1", preShareSeq, bobToken);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "No entry found with ID: h1" });
  });

  it("stale: 409, and nothing is written", async () => {
    const roots = await ensureTenantBootstrap(env);
    const { token: bobToken, member: bobMember } = await createMember(env, { name: "Bob" });
    const bob = (await resolveIdentityByUserId(env, bobMember.userId))!;
    seed("ci1", { tags: ["auto-insight"], workspaceId: roots.companyWorkspaceId, actorId: "" });
    const { applyInsightResolution } = await import("../../src/memory/actions");
    await applyInsightResolution(env, ctx, { actorId: bob.userId, channel: "rest" }, [{ id: "ci1", tags: row("ci1").tags, vector_ids: row("ci1").vector_ids, workspace_id: roots.companyWorkspaceId }], 1, "dismiss");
    const bobSeq = (await versions("ci1"))[0].seq;
    // A further change by someone else: Bob's own newest right (rule b) turns off.
    await updateEntryContent(env, "ci1", "canonical text", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, roots.companyWorkspaceId);
    const before = await versions("ci1");
    const res = await restUndo("ci1", bobSeq, bobToken);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "Entry changed after you looked at it; check history and try again." });
    expect(await versions("ci1")).toEqual(before);
  });

  it("reembed_failed: 500, and nothing is written", async () => {
    seed("f1", { content: "before" });
    await updateEntryContent(env, "f1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    const before = await versions("f1");
    (env.AI as any).run = vi.fn(async () => { throw new Error("AI down"); });
    const res = await restUndo("f1");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(row("f1").content).toBe("after");
    expect(await versions("f1")).toEqual(before);
  });
});

describe("MCP undo returns the specified sentence for every result", () => {
  it("reverted", async () => {
    seed("u2", { content: "before" });
    await updateEntryContent(env, "u2", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, owner.personalWorkspaceId);
    const text = await mcpUndo(owner, "u2");
    expect(text).toBe("Reverted entry u2 to how it was before its last change (version 1).");
  });

  it("restored", async () => {
    seed("t2", { content: "keep me" });
    await forgetEntry("t2", env, { actorId: owner.userId, channel: "mcp" }, { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
    expect(await mcpUndo(owner, "t2")).toBe("Restored entry t2 from the trash.");
  });

  it("no_change", async () => {
    seed("nc2", { content: "same", tags: ["a"] });
    await updateEntryContent(env, "nc2", "changed", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, owner.personalWorkspaceId);
    await updateEntryContent(env, "nc2", "same", DEFAULTS, undefined, ["a"], { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, owner.personalWorkspaceId);
    const before = (await versions("nc2"))[0].seq;
    expect(await mcpUndo(owner, "nc2", before)).toBe("Entry nc2 already matches that version; nothing changed.");
  });

  it("nothing_to_undo", async () => {
    seed("empty2");
    expect(await mcpUndo(owner, "empty2")).toBe("Entry empty2 has no recorded changes to undo.");
  });

  it("not_found", async () => {
    expect(await mcpUndo(owner, "nope2")).toBe("No entry found with ID: nope2");
  });

  it("forbidden", async () => {
    const roots = await ensureTenantBootstrap(env);
    const { member: bobMember } = await createMember(env, { name: "Bob" });
    const bob = (await resolveIdentityByUserId(env, bobMember.userId))!;
    seed("cf2", { content: "before", workspaceId: roots.companyWorkspaceId, actorId: owner.userId });
    await updateEntryContent(env, "cf2", "after", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, roots.companyWorkspaceId);
    expect(await mcpUndo(bob, "cf2")).toBe("Only the entry's author or an admin can modify a shared company memory");
  });

  it("stale", async () => {
    const roots = await ensureTenantBootstrap(env);
    const { member: bobMember } = await createMember(env, { name: "Bob" });
    const bob = (await resolveIdentityByUserId(env, bobMember.userId))!;
    seed("ci2", { tags: ["auto-insight"], workspaceId: roots.companyWorkspaceId, actorId: "" });
    const { applyInsightResolution } = await import("../../src/memory/actions");
    await applyInsightResolution(env, ctx, { actorId: bob.userId, channel: "mcp" }, [{ id: "ci2", tags: row("ci2").tags, vector_ids: row("ci2").vector_ids, workspace_id: roots.companyWorkspaceId }], 1, "dismiss");
    const bobSeq = (await versions("ci2"))[0].seq;
    await updateEntryContent(env, "ci2", "canonical text", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, roots.companyWorkspaceId);
    expect(await mcpUndo(bob, "ci2", bobSeq)).toBe("Entry ci2 changed after you looked at it; check history and try again.");
  });

  it("reembed_failed", async () => {
    seed("f2", { content: "before" });
    await updateEntryContent(env, "f2", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, owner.personalWorkspaceId);
    (env.AI as any).run = vi.fn(async () => { throw new Error("AI down"); });
    expect(await mcpUndo(owner, "f2")).toBe("Couldn't update entry f2: search re-index failed. Your memory is unchanged — please try again.");
  });
});

describe("REST and MCP undo leave identical rows and versions except channel", () => {
  it("update, undo through each surface", async () => {
    seed("pr1", { content: "before" });
    seed("pr2", { content: "before" });
    await updateEntryContent(env, "pr1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    await updateEntryContent(env, "pr2", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);

    expect((await restUndo("pr1")).status).toBe(200);
    expect(await mcpUndo(owner, "pr2")).toContain("Reverted");

    const [r1, r2] = [row("pr1"), row("pr2")];
    expect(r1.content).toBe(r2.content);
    expect(r1.tags).toBe(r2.tags);

    const [v1, v2] = [await versions("pr1"), await versions("pr2")];
    expect(v1).toHaveLength(v2.length);
    // Everything but the row's own identity (id, entry_id), timing (created_at, valid_from — the
    // two sequential real calls a moment apart) and each request's own random nonce (meta) — and
    // channel, which is the one thing REST and MCP are allowed, and expected, to differ on.
    const strip = (v: any) => {
      const { id, entry_id, created_at, valid_from, channel, meta, ...rest } = v;
      const { nonce, ...metaRest } = meta ? JSON.parse(meta) : {};
      return { ...rest, meta: metaRest };
    };
    for (let i = 0; i < v1.length; i++) expect(strip(v1[i])).toEqual(strip(v2[i]));
    expect(v1.at(-1).channel).toBe("rest");
    expect(v2.at(-1).channel).toBe("mcp");
  });
});

describe("undo is audited reverted with channel rest or mcp", () => {
  it("REST", async () => {
    seed("au1", { content: "before" });
    await updateEntryContent(env, "au1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    await restUndo("au1");
    const ev = (await events("au1")).find((e) => e.event === "reverted");
    expect(ev).toBeDefined();
    expect(JSON.parse(ev.payload)).toMatchObject({ channel: "rest" });
  });

  it("MCP", async () => {
    seed("au2", { content: "before" });
    await updateEntryContent(env, "au2", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, owner.personalWorkspaceId);
    await mcpUndo(owner, "au2");
    const ev = (await events("au2")).find((e) => e.event === "reverted");
    expect(ev).toBeDefined();
    expect(JSON.parse(ev.payload)).toMatchObject({ channel: "mcp" });
  });
});

describe("MCP undo has no parameter that can delete permanently", () => {
  it("the input schema has no permanent or confirm parameter", async () => {
    const server = buildMcpServer(env, ctx, owner);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === "undo")?.inputSchema as any;
      expect(schema.properties).not.toHaveProperty("permanent");
      expect(schema.properties).not.toHaveProperty("confirm");
    } finally {
      await client.close();
    }
  });
});
