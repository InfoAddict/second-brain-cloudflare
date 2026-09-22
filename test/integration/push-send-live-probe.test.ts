/**
 * Live-testing probe for the "exactly one successful send per run" bug: three
 * real runs against FCM with 2 and 1 subscriptions all reported sent:1. This
 * calls the real encrypt+send path (pushDueItems -> sendOne -> encryptWebPush)
 * TWICE in one run, against a mock fetch, and independently DECRYPTS both
 * POSTed bodies as a real push client would — using each subscription's own
 * private key, not just inspecting the ciphertext bytes — so a bug that
 * produces a wrong-but-plausible-looking second body is still caught.
 *
 * Root cause: encryptWebPush reused the persistent VAPID key pair as the
 * RFC 8291 ECDH "keyid" for every message, so both messages in a run shared
 * one ECDH keypair. The fix generates a fresh ephemeral ECDH key pair (and
 * the salt was already fresh) per call — this file pins that both keypairs
 * and both salts differ across two sends in the same run, and that each
 * message still decrypts to what was sent.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { pushDueItems } from "../../src/push/send";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { toBase64Url } from "../../src/push/base64url";
import type { Env } from "../../src/env";

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; resetDatabaseInit(); vi.restoreAllMocks(); });

function dbOf(s: SqliteD1) {
  return { prepare: (sql: string) => s.db.prepare(sql), exec: (sql: string) => s.db.exec(sql), batch: (stmts: any[]) => s.db.batch(stmts) };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  return s;
}

// ---- An independent (test-side) RFC 8291 client, mirroring the receiving
// half of src/push/crypto.ts's math without importing it — a bug that made
// both halves agree with each other would still be invisible otherwise. ----

interface UaKeyPair {
  publicKeyRaw: Uint8Array;
  privateKey: CryptoKey;
  authSecret: Uint8Array;
}

async function generateUaKeyPair(): Promise<UaKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  return { publicKeyRaw, privateKey: pair.privateKey, authSecret: crypto.getRandomValues(new Uint8Array(16)) };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

/** Parses the aes128gcm header (salt(16) + rs(4) + idlen(1) + keyid(idlen)) and returns it split from the ciphertext. */
function parseAes128gcmHeader(body: Uint8Array) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const keyid = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  return { salt, keyid, ciphertext };
}

/** The RFC 8291 receiver's half: same derivation, run with the UA's private key against the message's own ephemeral keyid. */
async function clientDecrypt(body: Uint8Array, ua: UaKeyPair): Promise<string> {
  const { salt, keyid, ciphertext } = parseAes128gcmHeader(body);

  const serverPublicKey = await crypto.subtle.importKey("raw", keyid, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: serverPublicKey } as any, ua.privateKey, 256),
  );

  const prkKeyCombining = await hmacSha256(ua.authSecret, ecdhSecret);
  const keyInfo = concatBytes(new TextEncoder().encode("WebPush: info\0"), ua.publicKeyRaw, keyid);
  const ikm = await hmacSha256(prkKeyCombining, concatBytes(keyInfo, Uint8Array.of(1)));

  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(prk, concatBytes(new TextEncoder().encode("Content-Encoding: aes128gcm\0"), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concatBytes(new TextEncoder().encode("Content-Encoding: nonce\0"), Uint8Array.of(1)))).slice(0, 12);

  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cekKey, ciphertext));
  // Strip the last-record delimiter (0x02) and any padding after it.
  const delimiterIndex = padded.lastIndexOf(2);
  return new TextDecoder().decode(padded.slice(0, delimiterIndex));
}

function seedDueAndSubscriptions(s: SqliteD1, uas: UaKeyPair[]) {
  s.seed({ id: "e1", content: "File the annual report", createdAt: 1000, tags: [] });
  s.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'model', when_label = 'File the report' WHERE id = 'e1'`)
    .bind(Date.now() - 86400000).run();
  uas.forEach((ua, i) => {
    s.db.prepare(
      `INSERT INTO push_subscriptions (id, workspace_id, endpoint_hash, subscription_json, content_free, created_at, fail_count)
       VALUES (?, '', ?, ?, 0, ?, 0)`,
    ).bind(
      `sub-${i}`, `hash-${i}`,
      JSON.stringify({ endpoint: `https://push.example.com/s${i}`, keys: { p256dh: toBase64Url(ua.publicKeyRaw), auth: toBase64Url(ua.authSecret) } }),
      Date.now(),
    ).run();
  });
}

describe("two subscriptions in one pushDueItems run", () => {
  it("sends and independently decrypts BOTH messages, with distinct salts and ephemeral keys", async () => {
    const sq_ = sq = await migrated();
    const uaA = await generateUaKeyPair();
    const uaB = await generateUaKeyPair();
    seedDueAndSubscriptions(sq_, [uaA, uaB]);
    const env = makeTestEnv(dbOf(sq_) as any, { OAUTH_KV: makeMemoryKV() });

    const postedBodies: Uint8Array[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: any, init: any) => {
      postedBodies.push(new Uint8Array(init.body));
      return new Response(null, { status: 201 });
    });

    const result = await pushDueItems(env, "");

    expect(result.sent).toBe(2);
    expect(postedBodies).toHaveLength(2);

    const headerA = parseAes128gcmHeader(postedBodies[0]);
    const headerB = parseAes128gcmHeader(postedBodies[1]);
    expect(toBase64Url(headerA.salt)).not.toBe(toBase64Url(headerB.salt));
    expect(toBase64Url(headerA.keyid)).not.toBe(toBase64Url(headerB.keyid));

    const plaintextA = JSON.parse(await clientDecrypt(postedBodies[0], uaA));
    const plaintextB = JSON.parse(await clientDecrypt(postedBodies[1], uaB));
    expect(plaintextA.entry_id).toBe("e1");
    expect(plaintextB.entry_id).toBe("e1");
    expect(plaintextA.title).toBe("File the report");
    expect(plaintextB.title).toBe("File the report");
  });

  it("still decrypts correctly with three subscriptions (not just two)", async () => {
    const sq_ = sq = await migrated();
    const uas = [await generateUaKeyPair(), await generateUaKeyPair(), await generateUaKeyPair()];
    seedDueAndSubscriptions(sq_, uas);
    const env = makeTestEnv(dbOf(sq_) as any, { OAUTH_KV: makeMemoryKV() });

    const postedBodies: Uint8Array[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: any, init: any) => {
      postedBodies.push(new Uint8Array(init.body));
      return new Response(null, { status: 201 });
    });

    const result = await pushDueItems(env, "");

    expect(result.sent).toBe(3);
    for (let i = 0; i < 3; i++) {
      const plaintext = JSON.parse(await clientDecrypt(postedBodies[i], uas[i]));
      expect(plaintext.entry_id).toBe("e1");
    }
    const keyids = postedBodies.map(b => toBase64Url(parseAes128gcmHeader(b).keyid));
    expect(new Set(keyids).size).toBe(3);
  });
});
