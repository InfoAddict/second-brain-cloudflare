/**
 * Strict MCP clients (src/mcp/sanitize.ts) budget the whole tools/list payload.
 * Task 7 (T-0089.7.1/.2/.3) adds standing, decision and commitment parameters
 * to `remember` (resolve's own new actions land in Task 8). This asserts the
 * growth over the pre-Task-7 baseline is at most 1,600 bytes.
 *
 * BASELINE_BYTES was measured by stashing this task's changes (`git stash
 * push -u`) and reading this same toolsListBytes() against the tree as Task 6
 * left it (commit 490d944b): 28,454 bytes. This commit's own tools/list
 * measures 29,789, a growth of 1,335 bytes — inside the budget. Both numbers
 * are pinned so a later change that quietly regrows the payload (a verbose
 * description rewrite, a duplicated schema block) fails here instead of only
 * at a strict client.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

async function toolsListBytes(): Promise<number> {
  const env = makeTestEnv(makeTestDb());
  const server = buildMcpServer(env, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return new TextEncoder().encode(JSON.stringify(tools)).length;
  } finally {
    await client.close();
  }
}

const BASELINE_BYTES = 28454;
const MAX_GROWTH_BYTES = 1600;

describe("tools/list size", () => {
  it("grows by at most 1,600 bytes over the pre-Task-7 baseline", async () => {
    const bytes = await toolsListBytes();
    expect(bytes - BASELINE_BYTES).toBeLessThanOrEqual(MAX_GROWTH_BYTES);
  });
});
