import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildMcpServer } from "../../src/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

const EXPECTED_TOOLS = [
  "remember",
  "recall",
  "list_recent",
  "append",
  "update",
  "set_status",
  "forget",
  "link",
  "unlink",
  "connections",
];

async function withMcpClient(env: Env, run: (client: Client) => Promise<void>) {
  const server = buildMcpServer(env, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

describe("MCP tools contract (InMemoryTransport)", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("listTools exposes all second brain tools", async () => {
    await withMcpClient(env, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const name of EXPECTED_TOOLS) {
        expect(names).toContain(name);
      }
    });
  });

  it("remember stores content and recall finds it", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockImplementation(async () => {
          const entry = db.entries[db.entries.length - 1];
          if (!entry) return { matches: [] };
          return {
            matches: [{
              id: entry.id,
              score: 0.95,
              metadata: { parentId: entry.id, isUpdate: false },
            }],
          };
        }),
      }),
    });

    await withMcpClient(env, async (client) => {
      const remember = await client.callTool({
        name: "remember",
        arguments: { content: "Issue 223 verification memory", tags: ["test"] },
      });
      expect(remember.isError).not.toBe(true);

      const recall = await client.callTool({
        name: "recall",
        arguments: { query: "User wants to verify MCP recall works — what was stored?" },
      });
      expect(recall.isError).not.toBe(true);
      const text = (recall.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toMatch(/Issue 223 verification memory/i);
    });
  });
});
