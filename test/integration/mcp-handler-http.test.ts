import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMcpHandler } from "agents/mcp";
import * as serverModule from "../../src/mcp/server";
import { createApiHandler } from "../../src/mcp/handler";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

vi.mock("../../src/mcp/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mcp/server")>();
  return { ...actual, buildMcpServer: vi.fn(actual.buildMcpServer) };
});

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

function mcpPost(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token", ...headers },
    body: JSON.stringify(body),
  });
}

describe("MCP HTTP handler (/mcp)", () => {
  let env: Env;
  let handler: ReturnType<typeof createApiHandler>;

  beforeEach(() => {
    env = makeTestEnv();
    handler = createApiHandler();
    vi.mocked(createMcpHandler).mockReturnValue((() =>
      Promise.resolve(new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "remember", description: "Store", inputSchema: {}, execution: { taskSupport: "optional" } },
            { name: "recall", description: "Search", inputSchema: {}, execution: { taskSupport: "optional" } },
          ],
        },
      }), { headers: { "content-type": "application/json" } }))) as never);
  });

  it("tools/list strips execution metadata from the handler response", async () => {
    const res = await handler.fetch(
      mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);

    const payload = await res.json() as { result: { tools: { name: string; execution?: unknown }[] } };
    const names = payload.result.tools.map((t) => t.name);
    expect(names).toContain("remember");
    expect(names).toContain("recall");
    for (const tool of payload.result.tools) {
      expect(tool).not.toHaveProperty("execution");
    }
  });

  it("non-tools/list requests pass the downstream response through unchanged", async () => {
    const downstream = new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } }), {
      headers: { "content-type": "application/json" },
    });
    vi.mocked(createMcpHandler).mockReturnValue((() => Promise.resolve(downstream)) as never);

    const res = await handler.fetch(
      mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }),
      env,
      ctx,
    );
    expect(res).toBe(downstream);
  });

  it("BE-5: reads ctx.props and passes {clientName, via} plus the bearer into buildMcpServer", async () => {
    const ctxWithProps = {
      waitUntil: (_: Promise<unknown>) => {},
      props: { userId: "owner", clientId: "client-1", clientName: "Cursor" },
    } as unknown as ExecutionContext;

    await handler.fetch(mcpPost({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }), env, ctxWithProps);

    expect(serverModule.buildMcpServer).toHaveBeenCalledWith(
      env, ctxWithProps, expect.anything(),
      expect.objectContaining({ clientName: "Cursor" }),
      "test-token",
    );
  });

  it("BE-5: a static-token caller's props carry via: token through to buildMcpServer", async () => {
    const ctxWithProps = {
      waitUntil: (_: Promise<unknown>) => {},
      props: { userId: "owner", via: "token" },
    } as unknown as ExecutionContext;

    await handler.fetch(mcpPost({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }), env, ctxWithProps);

    expect(serverModule.buildMcpServer).toHaveBeenCalledWith(
      env, ctxWithProps, expect.anything(),
      expect.objectContaining({ via: "token" }),
      "test-token",
    );
  });
});
