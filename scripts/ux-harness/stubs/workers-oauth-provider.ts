/**
 * Stand-in for "@cloudflare/workers-oauth-provider" (used by src/index.ts), whose real module
 * reaches into "cloudflare:workers", which does not exist outside the Workers runtime. Mirrors
 * vitest.setup.ts's own mock exactly: delegate non-apiRoute requests to the defaultHandler, and
 * gate the apiRoute with resolveExternalToken (the static AUTH_TOKEN path this harness uses) —
 * enough for the local Worker's real auth behavior to work, without OAuth's real grant machinery.
 */
export class OAuthProvider {
  options: any;
  constructor(options: any) { this.options = options; }
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === this.options.apiRoute) {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const grant = token ? await this.options.resolveExternalToken?.({ token, env }) : null;
      if (!grant) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      return this.options.apiHandler.fetch(request, env, ctx);
    }
    return this.options.defaultHandler.fetch(request, env, ctx);
  }
}
