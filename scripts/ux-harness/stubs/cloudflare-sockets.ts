/**
 * Stand-in for the "cloudflare:sockets" module (src/integrations/imap.ts's `connect()`), which
 * does not exist outside the Workers runtime. Mirrors vitest.setup.ts's own mock: IMAP capture is
 * out of scope for the UX walkthroughs, so a clear throw beats a silent no-op if a journey ever
 * reaches it by mistake.
 */
export function connect(): never {
  throw new Error("cloudflare:sockets connect() is not available in the local UX harness");
}
