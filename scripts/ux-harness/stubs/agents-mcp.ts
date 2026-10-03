/**
 * Stand-in for "agents/mcp" when running the real Worker outside workerd (see dev-server.ts):
 * the real module's dependency chain reaches into `cloudflare:workers`, which does not exist
 * outside the Workers runtime. Mirrors vitest.setup.ts's own `vi.mock("agents/mcp", ...)` exactly
 * — the browser dashboard never calls the stateful `/mcp` Durable Object transport this replaces;
 * chat walkthroughs exercise the real MCP server in-process (buildMcpServer + InMemoryTransport,
 * the same pattern the test suite already uses), never through this HTTP endpoint.
 */
export function createMcpHandler(): () => Response {
  return () => new Response("mcp");
}
