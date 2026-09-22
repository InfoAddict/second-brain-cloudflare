/**
 * RFC 8291 (Message Encryption for Web Push, aes128gcm) and RFC 8292 (VAPID,
 * ES256 JWT), checked against RFC 8291 Appendix A's own published test
 * vectors — fixed keys and salt, so the exact ciphertext is either right or
 * it isn't. This is the one place in this round where "close enough" is not
 * an acceptable bar: a wrong intermediate value here fails silently at the
 * push service instead of in a test.
 */
import { describe, it, expect } from "vitest";
import { encryptWebPush, signVapidJwt } from "../../src/push/crypto";
import { fromBase64Url, toBase64Url } from "../../src/push/base64url";

// RFC 8291 Appendix A, verbatim.
const PLAINTEXT_B64URL = "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24";
const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";

const EXPECTED_ECDH_SECRET = "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs";
const EXPECTED_PRK_KEY_COMBINING = "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k";
const EXPECTED_IKM = "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg";
const EXPECTED_PRK_CONTENT_ENCRYPTION = "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc";
const EXPECTED_CEK = "oIhVW04MRdy2XN9CiKLxTg";
const EXPECTED_NONCE = "4h_95klXJ5E_qnoN";
const EXPECTED_BODY =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

describe("encryptWebPush — RFC 8291 Appendix A", () => {
  it("reproduces every intermediate value and the final ciphertext exactly", async () => {
    const result = await encryptWebPush({
      plaintext: fromBase64Url(PLAINTEXT_B64URL),
      subscriptionPublicKey: fromBase64Url(UA_PUBLIC),
      subscriptionAuthSecret: fromBase64Url(AUTH_SECRET),
      serverPublicKeyRaw: fromBase64Url(AS_PUBLIC),
      serverPrivateKeyRaw: fromBase64Url(AS_PRIVATE),
      salt: fromBase64Url(SALT),
      recordSize: 4096,
    });

    expect(toBase64Url(result.ecdhSecret)).toBe(EXPECTED_ECDH_SECRET);
    expect(toBase64Url(result.prkKeyCombining)).toBe(EXPECTED_PRK_KEY_COMBINING);
    expect(toBase64Url(result.ikm)).toBe(EXPECTED_IKM);
    expect(toBase64Url(result.prkContentEncryption)).toBe(EXPECTED_PRK_CONTENT_ENCRYPTION);
    expect(toBase64Url(result.cek)).toBe(EXPECTED_CEK);
    expect(toBase64Url(result.nonce)).toBe(EXPECTED_NONCE);
    expect(toBase64Url(result.body)).toBe(EXPECTED_BODY);
  });

  it("uses the user agent's public key to derive, not the server's own", async () => {
    // Sanity check on the harness itself: swapping which public key stands in
    // for the subscription must NOT reproduce the vector above.
    const result = await encryptWebPush({
      plaintext: fromBase64Url(PLAINTEXT_B64URL),
      subscriptionPublicKey: fromBase64Url(AS_PUBLIC), // wrong on purpose
      subscriptionAuthSecret: fromBase64Url(AUTH_SECRET),
      serverPublicKeyRaw: fromBase64Url(AS_PUBLIC),
      serverPrivateKeyRaw: fromBase64Url(AS_PRIVATE),
      salt: fromBase64Url(SALT),
    });
    expect(toBase64Url(result.ecdhSecret)).not.toBe(EXPECTED_ECDH_SECRET);
  });

  it("produces a fresh random salt (and therefore a different body) when none is given", async () => {
    const a = await encryptWebPush({
      plaintext: fromBase64Url(PLAINTEXT_B64URL),
      subscriptionPublicKey: fromBase64Url(UA_PUBLIC),
      subscriptionAuthSecret: fromBase64Url(AUTH_SECRET),
      serverPublicKeyRaw: fromBase64Url(AS_PUBLIC),
      serverPrivateKeyRaw: fromBase64Url(AS_PRIVATE),
    });
    const b = await encryptWebPush({
      plaintext: fromBase64Url(PLAINTEXT_B64URL),
      subscriptionPublicKey: fromBase64Url(UA_PUBLIC),
      subscriptionAuthSecret: fromBase64Url(AUTH_SECRET),
      serverPublicKeyRaw: fromBase64Url(AS_PUBLIC),
      serverPrivateKeyRaw: fromBase64Url(AS_PRIVATE),
    });
    expect(toBase64Url(a.body)).not.toBe(toBase64Url(b.body));
  });
});

describe("signVapidJwt — RFC 8292", () => {
  it("produces a three-part JWT with alg ES256 and the given audience/subject", async () => {
    const publicKeyRaw = fromBase64Url(AS_PUBLIC);
    const privateKeyRaw = fromBase64Url(AS_PRIVATE);

    const jwt = await signVapidJwt({
      audience: "https://push.example.com",
      subject: "mailto:push@example.com",
      publicKeyRaw,
      privateKeyRaw,
      now: Date.parse("2027-01-01T00:00:00Z"),
    });

    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    expect(headerB64 && payloadB64 && sigB64).toBeTruthy();
    const header = JSON.parse(new TextDecoder().decode(fromBase64Url(headerB64)));
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(payload.aud).toBe("https://push.example.com");
    expect(payload.sub).toBe("mailto:push@example.com");
    expect(payload.exp).toBeGreaterThan(Date.parse("2027-01-01T00:00:00Z") / 1000);
    // Raw P-256 ECDSA signature (r || s), not DER: exactly 64 bytes.
    expect(fromBase64Url(sigB64)).toHaveLength(64);
  });

  it("verifies against the same key pair with WebCrypto", async () => {
    const publicKeyRaw = fromBase64Url(AS_PUBLIC);
    const privateKeyRaw = fromBase64Url(AS_PRIVATE);
    const jwt = await signVapidJwt({
      audience: "https://push.example.com",
      subject: "mailto:push@example.com",
      publicKeyRaw,
      privateKeyRaw,
    });
    const [headerB64, payloadB64, sigB64] = jwt.split(".");

    const key = await crypto.subtle.importKey(
      "raw", publicKeyRaw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64Url(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    expect(ok).toBe(true);
  });
});
