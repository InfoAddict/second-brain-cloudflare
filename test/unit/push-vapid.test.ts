import { describe, it, expect } from "vitest";
import { getOrCreateVapidKeys, vapidAuthHeader } from "../../src/push/vapid";
import { makeMemoryKV } from "../helpers/make-env";
import type { Env } from "../../src/env";

const envWith = (kv: KVNamespace) => ({ OAUTH_KV: kv }) as unknown as Env;

describe("getOrCreateVapidKeys", () => {
  it("generates a key pair on first use and persists it to KV", async () => {
    const kv = makeMemoryKV();
    const keys = await getOrCreateVapidKeys(envWith(kv));

    expect(keys.publicKeyRaw).toHaveLength(65);
    expect(keys.publicKeyRaw[0]).toBe(0x04); // uncompressed point marker
    expect(keys.privateKeyRaw.length).toBeGreaterThan(0);

    const stored = await kv.get("push:vapid");
    expect(stored).not.toBeNull();
  });

  it("reuses the stored key pair rather than generating a new one each call", async () => {
    const kv = makeMemoryKV();
    const first = await getOrCreateVapidKeys(envWith(kv));
    const second = await getOrCreateVapidKeys(envWith(kv));

    expect([...second.publicKeyRaw]).toEqual([...first.publicKeyRaw]);
    expect([...second.privateKeyRaw]).toEqual([...first.privateKeyRaw]);
  });

  it("is one pair for the whole deployment, not per workspace (single KV key)", async () => {
    const kv = makeMemoryKV();
    await getOrCreateVapidKeys(envWith(kv));

    const { keys } = await kv.list();
    expect(keys.map(k => k.name)).toEqual(["push:vapid"]);
  });
});

describe("vapidAuthHeader", () => {
  it("carries a vapid-scheme JWT and the public key, audience derived from the endpoint", async () => {
    const kv = makeMemoryKV();
    const env = envWith(kv);
    const keys = await getOrCreateVapidKeys(env);

    const header = await vapidAuthHeader(env, "https://push.example.com/some/subscription/id");

    expect(header).toMatch(/^vapid t=[^,]+, k=[^,]+$/);
    const match = header.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(match).not.toBeNull();
    const [, jwt, publicKeyB64] = match!;
    expect(jwt.split(".")).toHaveLength(3);

    const { fromBase64Url } = await import("../../src/push/base64url");
    expect([...fromBase64Url(publicKeyB64)]).toEqual([...keys.publicKeyRaw]);

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(jwt.split(".")[1])));
    expect(payload.aud).toBe("https://push.example.com");
  });
});
