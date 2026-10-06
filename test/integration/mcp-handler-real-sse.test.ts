import { vi } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// FX3 finding 1 (CRITICAL): vitest.setup.ts mocks agents/mcp for every test file, so no
// existing test ever exercised the real SDK's response. A real MCP client always sends
// Accept: application/json, text/event-stream (the SDK's own transport 406s without both -
// node_modules/@modelcontextprotocol/sdk/.../webStandardStreamableHttp.js:464-470), so the
// real response content-type is text/event-stream, not application/json.
//
// Unmocking agents/mcp outright pulls in its barrel (agents/dist/mcp/index.js), which
// re-exports from agents/dist/index.js for the Durable-Object Agent class - that file
// imports cloudflare:workers and cloudflare:email, which Node's ESM loader can't resolve
// outside a Workers runtime (this happens during static linking, before any vi.mock can
// intercept it). agents/mcp's real createMcpHandler compat layer sees buildMcpServer's
// v1-SDK McpServer instance and would route to createLegacyMcpHandler - also defined only
// in that same barrel, so equally unreachable here. Route to createStatelessMcpHandler
// instead: it's defined in its own deep file with no cloudflare:* imports, and its
// transport (WebStandardStreamableHTTPServerTransport) is the same family the legacy path
// uses, so the SSE body this produces - and the double-read bug in the two functions this
// test actually exercises - is the same shape production hits.
vi.mock("agents/mcp", async () => {
  const dir = resolve(import.meta.dirname, "../../node_modules/agents/dist");
  const file = readdirSync(dir).find(f => f.startsWith("handler-stateless-") && f.endsWith(".js"));
  if (!file) throw new Error("agents/dist/handler-stateless-*.js not found (agents package layout changed?)");
  const real = await import(/* @vite-ignore */ resolve(dir, file));
  const createStatelessMcpHandler = real.createStatelessMcpHandler ?? real.t;
  // buildMcpServer hands us an already-constructed server instance (the legacy v1-SDK
  // shape handler.ts's real createMcpHandler call also receives); the stateless handler
  // wants a factory, so wrap it the same way agents/mcp's own compat layer would.
  return {
    createMcpHandler: (server: unknown, opts?: unknown) => createStatelessMcpHandler(() => server, opts),
  };
});

import { describe, it, expect, beforeEach } from "vitest";
import { createApiHandler } from "../../src/mcp/handler";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

function mcpPost(body: unknown) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Both values are required: the SDK 406s a caller who does not offer text/event-stream.
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer test-token",
      // The real transport's DNS-rebinding guard reads this explicitly (fetch's Request
      // never synthesizes it); a worker request always carries one from the real edge.
      Host: "localhost",
    },
    body: JSON.stringify(body),
  });
}

/** A real client reads whichever content-type the transport actually chose. */
async function parseJsonRpcBody(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine = text.split("\n").find(l => l.startsWith("data: "));
    if (!dataLine) throw new Error(`no data: line in SSE body: ${JSON.stringify(text)}`);
    return JSON.parse(dataLine.slice("data: ".length));
  }
  return res.json();
}

describe("MCP HTTP handler with the real agents/mcp handler (FX3 finding 1)", () => {
  let env: Env;
  let handler: ReturnType<typeof createApiHandler>;

  beforeEach(() => {
    env = makeTestEnv();
    handler = createApiHandler();
  });

  it("tools/list: the body is intact and parses, not already consumed by rewriteDailyLimitToolErrors", async () => {
    const res = await handler.fetch(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), env, ctx);
    expect(res.status).toBe(200);
    const payload = await parseJsonRpcBody(res);
    expect(payload.error).toBeUndefined();
    expect(Array.isArray(payload.result?.tools)).toBe(true);
    expect(payload.result.tools.length).toBeGreaterThan(0);
    for (const tool of payload.result.tools) expect(tool).not.toHaveProperty("execution");
  });

  it("tools/call: the body is intact and parses, not already consumed by rewriteDailyLimitToolErrors", async () => {
    const res = await handler.fetch(
      mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_teams", arguments: {} } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const payload = await parseJsonRpcBody(res);
    expect(payload.error).toBeUndefined();
    expect(payload.result?.content).toBeDefined();
  });
});
