/**
 * One VAPID (RFC 8292) P-256 key pair for the whole deployment, generated on
 * first need and stored in the night-summary KV namespace (OAUTH_KV) as JWK —
 * NOT per workspace. Self-hosted zero-config is the point: there is nothing
 * to configure, and every subscriber shares one application-server identity.
 * The private key lives in KV in the clear, the same trust boundary this
 * Worker already gives AUTH_TOKEN and every OAuth secret.
 *
 * The same key pair also serves as the RFC 8291 message-encryption ECDH key
 * (src/push/crypto.ts) — see that module's comment for why reusing one static
 * key across subscribers and messages is an accepted simplification.
 */
import type { Env } from "../env";
import { fromBase64Url, toBase64Url } from "./base64url";
import { signVapidJwt } from "./crypto";

const VAPID_KV_KEY = "push:vapid";
const VAPID_SUBJECT = "mailto:push@second-brain.local";

interface StoredVapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface VapidKeys {
  publicKeyRaw: Uint8Array;
  privateKeyRaw: Uint8Array;
}

async function generateAndStore(env: Env): Promise<StoredVapidKeys> {
  // `as CryptoKeyPair`: the ECDSA overload of generateKey is otherwise
  // ambiguous with the symmetric-algorithm one in this project's lib target.
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey) as ArrayBuffer);
  const privateJwk = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as JsonWebKey;
  const stored: StoredVapidKeys = { publicKey: toBase64Url(publicKeyRaw), privateKey: privateJwk.d! };

  await env.OAUTH_KV.put(VAPID_KV_KEY, JSON.stringify(stored));
  // Two isolates can race this on the very first push feature use. Re-reading
  // after the write is not a full fix for KV's eventual consistency across
  // colos, but it converges same-colo races onto whichever put landed last
  // rather than this isolate blindly trusting its own generation.
  const settled = await env.OAUTH_KV.get(VAPID_KV_KEY);
  return settled ? (JSON.parse(settled) as StoredVapidKeys) : stored;
}

export async function getOrCreateVapidKeys(env: Env): Promise<VapidKeys> {
  const existing = await env.OAUTH_KV.get(VAPID_KV_KEY);
  const stored = existing ? (JSON.parse(existing) as StoredVapidKeys) : await generateAndStore(env);
  return { publicKeyRaw: fromBase64Url(stored.publicKey), privateKeyRaw: fromBase64Url(stored.privateKey) };
}

/** `Authorization: vapid t=<jwt>, k=<public key>` (RFC 8292 section 4), audience derived from the endpoint being called. */
export async function vapidAuthHeader(env: Env, endpoint: string): Promise<string> {
  const keys = await getOrCreateVapidKeys(env);
  const jwt = await signVapidJwt({
    audience: new URL(endpoint).origin,
    subject: VAPID_SUBJECT,
    publicKeyRaw: keys.publicKeyRaw,
    privateKeyRaw: keys.privateKeyRaw,
  });
  return `vapid t=${jwt}, k=${toBase64Url(keys.publicKeyRaw)}`;
}
