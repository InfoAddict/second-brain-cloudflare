import type { Env } from "../env";
import { resolveIdentityFromToken } from "../lib/identity";
import { authorizeErrorHint, authorizeErrorHtml, loginHtml } from "./pages";

export async function handleOAuthAuthorize(request: Request, env: Env): Promise<Response> {
  let oauthReq: any;
  try {
    // workers-oauth-provider mis-parses POST bodies; pass a URL-only GET clone
    // so parseAuthRequest reads the query params cleanly.
    const parseReq = request.method === "POST" ? new Request(request.url, { method: "GET" }) : request;
    oauthReq = await (env as any).OAUTH_PROVIDER.parseAuthRequest(parseReq);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("OAuth authorize parse failed:", detail);
    return new Response(authorizeErrorHtml(authorizeErrorHint(detail), detail), {
      status: 400, headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (request.method === "POST") {
    const form = await request.formData();
    const password = String(form.get("password") ?? "").trim();
    let grantUserId = "owner";
    let propsUserId = "owner";
    if (password !== env.AUTH_TOKEN) {
      const identity = await resolveIdentityFromToken(password, env);
      if (!identity) {
        return new Response(loginHtml("Invalid token"), {
          status: 401, headers: { "Content-Type": "text/html" },
        });
      }
      grantUserId = identity.userId;
      propsUserId = identity.userId;
    }
    // BE-5: the client's own registered name, read once at sign-in so every later
    // request carries it on ctx.props at no extra cost (src/mcp/client-label.ts,
    // resolveClientLabel's source 1). Absent entirely, not stored as "", when the
    // client registered without one — an empty prop and a missing prop must not
    // read the same to a caller checking `"clientName" in props`.
    const client = await (env as any).OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
    const clientName = client?.clientName;
    const { redirectTo } = await (env as any).OAUTH_PROVIDER.completeAuthorization({
      request: oauthReq,
      userId: grantUserId,
      scope: oauthReq.scope,
      props: { userId: propsUserId, clientId: oauthReq.clientId, ...(clientName ? { clientName } : {}) },
    });
    return Response.redirect(redirectTo, 302);
  }
  return new Response(loginHtml(), { headers: { "Content-Type": "text/html" } });
}
