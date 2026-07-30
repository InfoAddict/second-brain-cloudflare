/**
 * Disconnecting every AI tool (#235 §6).
 *
 * `AUTH_TOKEN` is the brain's password, but it is not the only credential that
 * opens a brain. Clients that came in through `/oauth/authorize` — Claude Code,
 * Cursor — hold tokens issued by `@cloudflare/workers-oauth-provider` and stored
 * in `OAUTH_KV`. Those are validated against KV, never against `AUTH_TOKEN`, so
 * changing the password leaves them connected and working.
 *
 * That is the right behaviour for a routine password change and the wrong one
 * after a leak: whoever used the leaked password to complete an authorization
 * keeps access permanently. This route is the explicit way to close that door,
 * kept separate from rotation so neither action silently does the other's work.
 *
 * ## What actually has to be deleted
 *
 * Verified against `@cloudflare/workers-oauth-provider@0.8.2`
 * (`dist/oauth-provider.js`), which writes four families of key:
 *
 * - `grant:<userId>:<grantId>` — the authorization itself. Refresh tokens are
 *   *not* a separate key family: `refreshTokenId` / `previousRefreshTokenId`
 *   live inside this record, so deleting the grant kills the refresh tokens
 *   with it.
 * - `token:<userId>:<grantId>:<tokenId>` — access tokens. These must go too,
 *   and this is the part a grant-only implementation gets wrong: token
 *   validation (`handleApiRequest`) looks up the `token:` key and reads the
 *   client's props straight out of it. It never checks that the grant still
 *   exists. Delete only the grants and every live access token keeps working
 *   until it expires on its own.
 * - `client:<clientId>` — dynamic client registrations. Deliberately kept. A
 *   registration is an app's identity, not a credential for this brain: with no
 *   grant behind it, the client can do nothing but start a fresh authorization,
 *   which needs the password. Deleting it would instead make clients that
 *   cached their `client_id` fail with `invalid_client` rather than simply
 *   asking to reconnect — a worse experience for no security gain.
 * - `enterprise-jti:<hash>` — EMA replay markers, TTL'd. Not credentials.
 *   Deleting them would weaken replay protection, not strengthen anything.
 *
 * There is no separate user→grant index to clean up; the provider enumerates
 * grants with a prefix list, exactly as this route does.
 *
 * `OAUTH_KV` is shared with the rest of the Worker — `config:overrides`,
 * `migration:embedding`, `integrations:<provider>`. Wiping those would be a
 * data-loss bug far worse than the problem this solves, so the scan is
 * prefix-scoped and every key is re-checked before it is deleted.
 */
import type { Env } from "../env";
import { json, requireAuth } from "../lib/http";

/**
 * The key families that constitute a live OAuth connection. Everything else in
 * `OAUTH_KV` is either the Worker's own state or an inert client registration —
 * see the module comment for why each of those is left alone.
 */
const REVOCABLE_PREFIXES = ["grant:", "token:"] as const;

/**
 * Cloudflare's maximum `list()` page size. Asking for it explicitly keeps the
 * number of round trips low; it does not remove the need to page, because KV
 * decides how much it returns regardless of what was requested.
 */
const LIST_PAGE_LIMIT = 1000;

export async function handleOAuthRevokeRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  // POST /oauth/revoke-all — sign out every client that authorized through the
  // browser flow. POST only: a GET that fell through to this would revoke every
  // connection on a page load or a link preview.
  if (url.pathname === "/oauth/revoke-all" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let revoked = 0;
    let failed = 0;

    for (const prefix of REVOCABLE_PREFIXES) {
      // KV `list()` is paginated. A single call returns one page plus a cursor,
      // and a brain with more grants than fit in a page would be *partially*
      // revoked by a one-shot implementation — which is the worst outcome a
      // security action can have, because it reports success while leaving
      // access open. Page until KV says it is done.
      //
      // Deleting keys that earlier pages already returned is safe: the cursor
      // resumes after the last key name it handed out, so removing keys behind
      // it cannot make the scan skip anything ahead of it.
      let cursor: string | undefined;
      do {
        const page = await env.OAUTH_KV.list({ prefix, limit: LIST_PAGE_LIMIT, cursor });
        for (const key of page.keys) {
          // KV already filtered by prefix; this re-check is the guard that a
          // widened scan can never reach `config:overrides`,
          // `migration:embedding` or `integrations:*`.
          if (!key.name.startsWith(prefix)) continue;
          try {
            await env.OAUTH_KV.delete(key.name);
            revoked++;
          } catch (e) {
            // Deleting a page is not atomic and there is nothing to roll back
            // to. The honest response is the count that actually went away,
            // not a success claim covering keys that are still there.
            console.error("Revoke failed for OAuth key", key.name, e);
            failed++;
          }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }

    // `ok` reports whether every connection found was actually closed, so a
    // partial revocation cannot read as a clean one. It stays a 200 either way:
    // `revoked` is the number the app tells the user, and a non-2xx invites a
    // caller to throw the body away along with the count.
    return json({ ok: failed === 0, revoked, failed });
  }

  return null;
}
