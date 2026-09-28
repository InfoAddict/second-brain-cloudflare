/**
 * Codex review class D copy (T-0089.4.2, copy deck section 9): the pending-scan hold gets its
 * own reply text, distinct from the generic held template — it explains a delay, not a
 * suspicion. Real SQLite, MCP client/server pair, and the REST route directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server";
import worker from "../../src/index";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let identity: Identity;
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

async function call(name: string, args: Record<string, unknown> = {}) {
  const server = buildMcpServer(env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pending-scan-copy-test", version: "1" });
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
});
afterEach(() => sqlite.close());

const HEAD = 24 * 1024;
const TAIL = 8 * 1024;
const benignLongContent = () => "x".repeat(HEAD + TAIL + 2000);

describe("MCP remember reply for a pending-scan hold", () => {
  it("uses the class D copy, not the generic held template", async () => {
    const text = await call("remember", { content: benignLongContent() });
    expect(text).toMatch(/^Stored\. ID: [0-9a-f-]{36}\. Held out of search for now: it is too long to check all at once\./);
    expect(text).toContain("The nightly check reads it over one or more nights");
    expect(text).not.toContain("held out of recall");
  });
});

describe("MCP get held line for a pending-scan hold", () => {
  it("shows the checking line", async () => {
    const remember = await call("remember", { content: benignLongContent() });
    const id = remember.match(/ID: ([0-9a-f-]{36})/)?.[1]!;
    const text = await call("get", { id });
    expect(text.startsWith("held: still being checked (too long to check at once); joins search after the nightly check\n")).toBe(true);
  });
});

describe("REST POST /capture for a pending-scan hold", () => {
  it("returns held.reason 'checking', not the internal name", async () => {
    const res = await worker.fetch(req("POST", "/capture", { body: { content: benignLongContent() } }), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.held).toEqual({ reason: "checking" });
    expect(data.message).toContain("held out of search until the nightly check");
  });
});
