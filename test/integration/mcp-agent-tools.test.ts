import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { createProject } from "../../src/projects/registry";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";
import * as compression from "../../src/compression/digest";

let sqlite: SqliteD1;
let env: Env;
let identity: Identity;
let pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;

async function call(name: string, args: Record<string, unknown> = {}, user: Identity | null = identity) {
  const server = buildMcpServer(env, ctx, user ?? undefined);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-tools-test", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return String((result.content as { text?: string }[])[0]?.text ?? "");
  } finally {
    await client.close();
    await server.close();
  }
}

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
  identity = (await resolveIdentityFromToken("test-token", env))!;
  sqlite.issued.length = 0;
});
afterEach(async () => { await Promise.all(pending); sqlite?.close(); });

describe("MCP brief", () => {
  it("returns a quiet empty state and rejects unauthenticated reads", async () => {
    expect(await call("brief")).toBe("Nothing needs attention.");
    expect(await call("brief", {}, null)).toMatch(/authenticated identity/i);
  });

  it("returns capped due, loops, stale and insight sections within twelve statements", async () => {
    const now = Date.now();
    await createProject(env.DB, identity.personalWorkspaceId, { id: "site", name: "Site", aliases: ["hosting"] });
    for (let i = 0; i < 8; i++) {
      sqlite.seed({ id: `due-${i}`, content: `Pay invoice ${i}`, createdAt: now, tags: ["task", i % 2 ? "hosting" : "project:site"] });
      await env.DB.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'explicit' WHERE id = ?`).bind(now + i * 1000, `due-${i}`).run();
    }
    sqlite.seed({ id: "stale-1", content: "Old site fact", createdAt: 1, tags: ["hosting", "stale:as-of"] });
    sqlite.seed({ id: "insight-1", content: "Site pattern", createdAt: now, tags: ["project:site", "auto-insight"] });
    sqlite.seed({ id: "other", content: "Other task", createdAt: now, tags: ["task"] });
    sqlite.issued.length = 0;
    const text = await call("brief", { project: "site" });
    expect(text).toContain("Due");
    expect(text).toContain("due-0");
    expect(text.split("Open commitments")[0]).not.toContain("due-7");
    expect(text).toContain("Open commitments");
    expect(text).toContain("May be out of date (1)");
    expect(text).toContain("stale-1");
    expect(text).toContain("Pending insights (1)");
    expect(text).toContain("insight-1");
    expect(text).not.toContain("Other task");
    expect(sqlite.issued).toHaveLength(5);
  });
});

describe("MCP resolve", () => {
  it("marks one task done with a channel audit in at most four statements", async () => {
    sqlite.seed({ id: "todo", content: "Send invoice", createdAt: 1, tags: ["task"] });
    sqlite.issued.length = 0;
    expect(await call("resolve", { id: "todo", action: "done" })).toMatch(/todo.*done/i);
    await Promise.all(pending);
    expect(sqlite.rows().find(r => r.id === "todo")?.tags).toContain("task:done");
    const event = await env.DB.prepare(`SELECT payload FROM entry_events WHERE entry_id = 'todo'`).first<{ payload: string }>();
    expect(JSON.parse(event!.payload)).toMatchObject({ loop_action: "done", channel: "mcp" });
    expect(sqlite.issued.length - 1).toBe(3);
  });

  it("requires until for snooze and a specific actionable id", async () => {
    expect(await call("resolve", { id: "todo", action: "snooze" })).toContain("until is required");
    expect(await call("resolve", { id: "missing", action: "done" })).toContain("No entry found");
  });

  it("confirms insights and keeps stale memories on the user's word", async () => {
    sqlite.seed({ id: "insight", content: "Pattern", createdAt: 1, tags: ["auto-insight"] });
    sqlite.seed({ id: "stale", content: "Still true", createdAt: 1, tags: ["stale:as-of"] });
    sqlite.issued.length = 0;
    expect(await call("resolve", { id: "insight", action: "confirm_insight" })).toMatch(/insight.*confirm/i);
    await Promise.all(pending);
    expect(sqlite.issued).toHaveLength(3);
    sqlite.issued.length = 0;
    expect(await call("resolve", { id: "stale", action: "still_true" })).toMatch(/stale.*still_true/i);
    await Promise.all(pending);
    expect(sqlite.issued).toHaveLength(3);
    const tags = Object.fromEntries(sqlite.rows().map(r => [r.id, JSON.parse(String(r.tags)) as string[]]));
    expect(tags.insight).toContain("status:canonical");
    expect(tags.insight).not.toContain("auto-insight");
    expect(tags.stale).not.toContain("stale:as-of");
  });

  it("handles not_a_task, snooze, clear_date, and dismiss_insight", async () => {
    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    sqlite.seed({ id: "task", content: "Maybe task", createdAt: 1, tags: ["task"] });
    sqlite.seed({ id: "dated", content: "Pay later", createdAt: 1, tags: ["task"] });
    sqlite.seed({ id: "insight", content: "Bad pattern", createdAt: 1, tags: ["auto-insight"] });
    expect(await call("resolve", { id: "task", action: "not_a_task" })).toContain("not_a_task");
    expect(await call("resolve", { id: "dated", action: "snooze", until: future })).toContain("snooze");
    expect((sqlite.rows().find(r => r.id === "dated")?.when_at as number)).toBeGreaterThan(Date.now());
    expect(await call("resolve", { id: "dated", action: "clear_date" })).toContain("clear_date");
    expect(await call("resolve", { id: "insight", action: "dismiss_insight" })).toContain("dismiss_insight");
    const rows = Object.fromEntries(sqlite.rows().map(r => [r.id, r]));
    expect(JSON.parse(String(rows.task.tags))).not.toContain("task");
    expect(rows.dated.when_at).toBeNull();
    expect(rows.dated.when_source).toBe("cleared");
    expect(JSON.parse(String(rows.insight.tags))).toContain("status:deprecated");
  });

  it("does not resolve another member's personal entry", async () => {
    const other = await createMember(env, { name: "Other" });
    sqlite.seed({ id: "private", content: "Private task", createdAt: 1, tags: ["task"] });
    await env.DB.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'private'`).bind(other.member.personalWorkspaceId).run();
    const member = await createMember(env, { name: "Reader" });
    const reader = (await resolveIdentityFromToken(member.token, env))!;
    expect(await call("resolve", { id: "private", action: "done" }, reader)).toContain("No entry found");
    expect(JSON.parse(String(sqlite.rows().find(r => r.id === "private")?.tags))).not.toContain("task:done");
  });
});

describe("MCP digest", () => {
  it("returns the latest existing project digest and never runs compression", async () => {
    const compress = vi.spyOn(compression, "compressTag");
    try {
      await createProject(env.DB, identity.personalWorkspaceId, { id: "site", name: "Site" });
      sqlite.seed({ id: "older", content: "Older summary", createdAt: 1000, tags: ["synthesized", "project:site"] });
      sqlite.seed({ id: "latest", content: "Current summary", createdAt: 2000, tags: ["synthesized", "project:site"] });
      sqlite.seed({ id: "wrong", content: "Wrong summary", createdAt: 3000, tags: ["synthesized", "other"] });
      sqlite.issued.length = 0;
      const text = await call("digest", { project: "site" });
      expect(text).toContain("Current summary");
      expect(text).toContain("1970-01-01");
      expect(text).not.toContain("Older summary");
      expect(text).not.toContain("Wrong summary");
      expect(sqlite.issued).toHaveLength(2);
      expect(compress).not.toHaveBeenCalled();
      expect(env.AI.run).not.toHaveBeenCalled();
    } finally { compress.mockRestore(); }
  });

  it("requires exactly one filter and suggests recall when no digest exists", async () => {
    await createProject(env.DB, identity.personalWorkspaceId, { id: "site", name: "Site" });
    expect(await call("digest", {})).toContain("exactly one");
    expect(await call("digest", { tag: "work", project: "site" })).toContain("exactly one");
    expect(await call("digest", { tag: "work" })).toContain("No digest yet");
    expect(await call("digest", { project: "missing" })).toContain("Known projects");
    expect(await call("digest", {}, null)).toContain("authenticated identity");
  });

  it("matches a topic tag literally in one statement", async () => {
    sqlite.seed({ id: "match", content: "Quarter three summary", createdAt: 1000, tags: ["synthesized", "q3_2026"] });
    sqlite.seed({ id: "near", content: "Wrong summary", createdAt: 2000, tags: ["synthesized", "q3-2026"] });
    sqlite.issued.length = 0;
    const text = await call("digest", { tag: "q3_2026" });
    expect(text).toContain("Quarter three summary");
    expect(text).not.toContain("Wrong summary");
    expect(sqlite.issued).toHaveLength(1);
  });
});
