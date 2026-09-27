import { createMcpHandler } from "agents/mcp";
import type { Env } from "../env";
import { extractToken, requireIdentityForMcp } from "../lib/identity";
import { ensureDbReady } from "../runtime/state";
import { buildMcpServer } from "./server";
import type { McpClientProps } from "./client-label";
import { isMcpToolsListRequest, sanitizeToolsListResponse } from "./sanitize";

type McpExecutionContext = ExecutionContext & { props?: { userId?: string } & McpClientProps };

export function createApiHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      ensureDbReady(ctx, env);
      const props = (ctx as McpExecutionContext).props;
      const auth = await requireIdentityForMcp(request, env, props?.userId);
      if (auth instanceof Response) return auth;
      // BE-5: ctx.props carries the OAuth grant's own clientName (or via:"token"
      // for a static bearer, src/index.ts's resolveExternalToken), read once here
      // per request and handed to every write tool through resolveClientLabel.
      const clientProps: McpClientProps | undefined = props
        ? { clientId: props.clientId, clientName: props.clientName, via: props.via }
        : undefined;
      const server = buildMcpServer(env, ctx, auth, clientProps, extractToken(request));
      const isToolsList = await isMcpToolsListRequest(request);
      const response = await createMcpHandler(server)(request, env, ctx);
      return isToolsList ? sanitizeToolsListResponse(response) : response;
    },
  };
}

export const apiHandler = createApiHandler();
