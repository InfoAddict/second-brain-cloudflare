import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { createProject } from "../../src/projects/registry";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let identity: Identity;
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

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
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
  identity = (await resolveIdentityFromToken("test-token", env))!;
  sqlite.issued.length = 0;
});
afterEach(() => sqlite?.close());

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
