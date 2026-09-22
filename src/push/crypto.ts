/**
 * RFC 8291 (Message Encryption for Web Push, aes128gcm) and RFC 8292 (VAPID,
 * ES256 JWT), built entirely on WebCrypto — no npm dependency. Every
 * intermediate value is returned rather than only the final ciphertext, so
 * this can be checked against RFC 8291 Appendix A's published test vectors
 * step by step (test/unit/push-crypto.test.ts) instead of trusting the last
 * byte alone.
 */
import { toBase64Url } from "./base64url";

/** aes128gcm record size, RFC 8188's own suggested default. One record per message. */
const DEFAULT_RECORD_SIZE = 4096;
/** RFC 8292 section 2: 24 hours is the outer bound most push services enforce. */
const VAPID_JWT_TTL_SECONDS = 12 * 60 * 60;

const textEncoder = new TextEncoder();

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** A raw uncompressed P-256 point (and optionally its private scalar) as the JWK WebCrypto needs to import it. */
function rawEcToJwk(publicRaw: Uint8Array, privateRaw?: Uint8Array): JsonWebKey {
  if (publicRaw.length !== 65 || publicRaw[0] !== 0x04) {
    throw new Error("Expected an uncompressed P-256 point (65 bytes, leading 0x04)");
  }
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(publicRaw.slice(1, 33)),
    y: toBase64Url(publicRaw.slice(33, 65)),
    ext: true,
  };
  if (privateRaw) jwk.d = toBase64Url(privateRaw);
  return jwk;
}

async function importEcdhPrivateKey(publicRaw: Uint8Array, privateRaw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk", rawEcToJwk(publicRaw, privateRaw), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
  );
}

/** A fresh P-256 ECDH key pair, raw-encoded, for one message's aes128gcm header (RFC 8291's "keyid"). */
async function generateEphemeralEcdhKeyPair(): Promise<{ publicKeyRaw: Uint8Array; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  ) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  return { publicKeyRaw, privateKey: pair.privateKey };
}

async function importEcdhPublicKey(publicRaw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", publicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

export interface EncryptWebPushOptions {
  plaintext: Uint8Array;
  /** Subscription's p256dh, a 65-byte uncompressed P-256 point. */
  subscriptionPublicKey: Uint8Array;
  /** Subscription's auth secret, 16 bytes. */
  subscriptionAuthSecret: Uint8Array;
  /**
   * Fixes the ECDH key pair used as this message's aes128gcm header "keyid",
   * instead of generating a fresh ephemeral one below. Only ever set by the
   * RFC 8291 Appendix A vector test, which has to reproduce its fixed keys
   * exactly — every real caller omits both and gets a fresh pair per call.
   */
  serverPublicKeyRaw?: Uint8Array;
  serverPrivateKeyRaw?: Uint8Array;
  /** 16 random bytes. Injectable so the RFC 8291 test vector's fixed salt is reproducible; omit in production. */
  salt?: Uint8Array;
  recordSize?: number;
}

export interface EncryptWebPushResult {
  /** aes128gcm header + ciphertext, exactly the push request body. */
  body: Uint8Array;
  /** This message's ECDH public key — embedded in `body`'s header, returned for tests/logging. */
  ephemeralPublicKeyRaw: Uint8Array;
  ecdhSecret: Uint8Array;
  prkKeyCombining: Uint8Array;
  ikm: Uint8Array;
  prkContentEncryption: Uint8Array;
  cek: Uint8Array;
  nonce: Uint8Array;
}

/**
 * Encrypts `plaintext` for one subscription, per RFC 8291.
 *
 * A fresh ephemeral P-256 ECDH key pair is generated per call (RFC 8291's own
 * recommendation) and used only for this one message's "keyid" — it has
 * nothing to do with the deployment's persistent VAPID identity key
 * (src/push/vapid.ts), which signs the JWT but never touches the ECDH
 * derivation. An earlier version of this function reused the static VAPID
 * key pair for ECDH as well, which is architecturally the wrong shape (RFC
 * 8291's message-encryption key and RFC 8292's identity key are unrelated by
 * design) even though nothing in the math itself requires per-message keys.
 */
export async function encryptWebPush(opts: EncryptWebPushOptions): Promise<EncryptWebPushResult> {
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const recordSize = opts.recordSize ?? DEFAULT_RECORD_SIZE;

  let serverPublicKeyRaw: Uint8Array;
  let serverPrivateKey: CryptoKey;
  if (opts.serverPublicKeyRaw && opts.serverPrivateKeyRaw) {
    serverPublicKeyRaw = opts.serverPublicKeyRaw;
    serverPrivateKey = await importEcdhPrivateKey(opts.serverPublicKeyRaw, opts.serverPrivateKeyRaw);
  } else {
    const ephemeral = await generateEphemeralEcdhKeyPair();
    serverPublicKeyRaw = ephemeral.publicKeyRaw;
    serverPrivateKey = ephemeral.privateKey;
  }

  const uaPublicKey = await importEcdhPublicKey(opts.subscriptionPublicKey);
  // `as any`: EcdhKeyDeriveParams isn't declared in this project's lib target.
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey } as any, serverPrivateKey, 256),
  );

  // RFC 8291 section 3.4: combine the ECDH secret with the subscription's
  // auth secret (as the HKDF salt), keyed to both parties' public keys.
  const prkKeyCombining = await hmacSha256(opts.subscriptionAuthSecret, ecdhSecret);
  const keyInfo = concatBytes(
    textEncoder.encode("WebPush: info\0"),
    opts.subscriptionPublicKey,
    serverPublicKeyRaw,
  );
  const ikm = await hmacSha256(prkKeyCombining, concatBytes(keyInfo, Uint8Array.of(1)));

  // RFC 8188 (aes128gcm) content coding, keyed by the random salt this time.
  const prkContentEncryption = await hmacSha256(salt, ikm);
  const cekInfo = textEncoder.encode("Content-Encoding: aes128gcm\0");
  const cek = (await hmacSha256(prkContentEncryption, concatBytes(cekInfo, Uint8Array.of(1)))).slice(0, 16);
  const nonceInfo = textEncoder.encode("Content-Encoding: nonce\0");
  const nonce = (await hmacSha256(prkContentEncryption, concatBytes(nonceInfo, Uint8Array.of(1)))).slice(0, 12);

  // Single record: append the last-record delimiter (0x02) with no further padding.
  const padded = concatBytes(opts.plaintext, Uint8Array.of(2));
  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, padded));

  const recordSizeBytes = new Uint8Array(4);
  new DataView(recordSizeBytes.buffer).setUint32(0, recordSize, false);
  const header = concatBytes(
    salt, recordSizeBytes, Uint8Array.of(serverPublicKeyRaw.length), serverPublicKeyRaw,
  );

  return {
    body: concatBytes(header, ciphertext),
    ephemeralPublicKeyRaw: serverPublicKeyRaw,
    ecdhSecret, prkKeyCombining, ikm, prkContentEncryption, cek, nonce,
  };
}

export interface SignVapidJwtOptions {
  /** Origin (scheme + host) of the push endpoint being called. */
  audience: string;
  subject: string;
  publicKeyRaw: Uint8Array;
  privateKeyRaw: Uint8Array;
  now?: number;
  ttlSeconds?: number;
}

/**
 * RFC 8292 VAPID JWT: header/payload/signature, ES256. WebCrypto's ECDSA
 * signature over P-256 is already the raw (r || s, 64-byte) form JWS
 * requires — no DER-to-raw conversion needed, unlike most non-browser crypto
 * libraries.
 */
export async function signVapidJwt(opts: SignVapidJwtOptions): Promise<string> {
  const now = opts.now ?? Date.now();
  const exp = Math.floor(now / 1000) + (opts.ttlSeconds ?? VAPID_JWT_TTL_SECONDS);
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: opts.audience, exp, sub: opts.subject };

  const encodedHeader = toBase64Url(textEncoder.encode(JSON.stringify(header)));
  const encodedPayload = toBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signKey = await crypto.subtle.importKey(
    "jwk", rawEcToJwk(opts.publicKeyRaw, opts.privateKeyRaw), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signKey, textEncoder.encode(signingInput)),
  );

  return `${signingInput}.${toBase64Url(signature)}`;
}
