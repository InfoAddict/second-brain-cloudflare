/**
 * Second Brain — Cloudflare Worker
 * https://github.com/rahilp/second-brain-cloudflare
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { runNightlyCompression } from "./compression/nightly";
import { runGraphPass } from "./graph/pass";
import { runScheduledIntegrationSync } from "./integrations/mirror";
import { runStalenessPass } from "./staleness/pass";
import { apiHandler } from "./mcp/handler";
import { augmentOAuthRegistrationRequest } from "./oauth/register";
import { defaultHandler } from "./routes";

export type { Env } from "./env";

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  // Accept the static AUTH_TOKEN for Claude Desktop + mcp-remote (no browser flow).
  resolveExternalToken: async ({ token, env }) => {
    if (token === (env as Env).AUTH_TOKEN) {
      return { props: { userId: "owner" } };
    }
    return null;
  },
});

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(req.url);
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      const augmented = await augmentOAuthRegistrationRequest(req);
      return oauthProvider.fetch(augmented, env as any, ctx);
    }
    return oauthProvider.fetch(req, env as any, ctx);
  },
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    // The jobs are independent, and each begins by awaiting the shared schema init. One
    // of them failing — including on that init — must not take the others down or surface
    // as an unhandled rejection inside waitUntil.
    const job = (name: string, run: Promise<void>) =>
      ctx.waitUntil(run.catch((e) => console.error(`${name} failed (non-fatal):`, e)));
    job("nightly compression", runNightlyCompression(env, ctx));
    job("graph pass", runGraphPass(env, ctx));
    job("integration sync", runScheduledIntegrationSync(env));
    job("staleness pass", runStalenessPass(env, ctx));
  },
};
