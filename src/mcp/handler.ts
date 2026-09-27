import { createMcpHandler } from "agents/mcp";
import type { Env } from "../env";
import { requireIdentityForMcp } from "../lib/identity";
import { ensureDbReady } from "../runtime/state";
import { buildMcpServer } from "./server";
import { isMcpToolsListRequest, sanitizeToolsListResponse } from "./sanitize";
import { rewriteDailyLimitToolErrors } from "./daily-limit-response";

type McpExecutionContext = ExecutionContext & { props?: { userId?: string } };

export function createApiHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      ensureDbReady(ctx, env);
      const oauthUserId = (ctx as McpExecutionContext).props?.userId;
      // R3 (budget audit, MAJOR): identity resolution is itself a D1 read, so a spent daily D1
      // cap throws HERE, before any tool runs. Left to propagate, it reaches the caller through
      // src/index.ts's top-level catch (the "top-level fetch handler" for both REST and MCP).
      const auth = await requireIdentityForMcp(request, env, oauthUserId);
      if (auth instanceof Response) return auth;
      const server = buildMcpServer(env, ctx, auth);
      const isToolsList = await isMcpToolsListRequest(request);
      const response = await createMcpHandler(server)(request, env, ctx);
      // R3 continued: a D1 cap hit INSIDE a tool call never reaches the block above — the SDK's
      // own dispatch already caught it and turned it into a normal-looking CallToolResult whose
      // text is the raw D1 error ("D1_ERROR: ... daily row read/write limit ..."), see
      // node_modules/@modelcontextprotocol/sdk .../server/mcp.js's tool-call catch. This is the
      // one place that response is visible to rewrite it into the named MCP sentence.
      const withDailyLimit = await rewriteDailyLimitToolErrors(response);
      return isToolsList ? sanitizeToolsListResponse(withDailyLimit) : withDailyLimit;
    },
  };
}

export const apiHandler = createApiHandler();
