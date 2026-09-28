/**
 * BE-5 (T-0101.5.1): resolveClientLabel's fallback chain, in isolation from the
 * MCP transport. Source 3.2: initialize.clientInfo is never reachable on a
 * tools/call in this stateless-per-request server, so the label is resolved
 * from the OAuth grant, a legacy grant lookup, _meta, or a ?client= URL,
 * first match wins.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveClientLabel, __resetClientLabelCacheForTests } from "../../src/mcp/client-label";
import type { Env } from "../../src/env";

function envWithOauth(overrides: { unwrapToken?: any; lookupClient?: any } = {}): Env {
  return {
    OAUTH_PROVIDER: {
      unwrapToken: overrides.unwrapToken ?? vi.fn().mockResolvedValue(null),
      lookupClient: overrides.lookupClient ?? vi.fn().mockResolvedValue(null),
    },
  } as unknown as Env;
}

beforeEach(() => { __resetClientLabelCacheForTests(); });

describe("resolveClientLabel", () => {
  it("uses the OAuth grant's clientName when present", async () => {
    const env = envWithOauth();
    const label = await resolveClientLabel({ clientName: "Cursor" }, undefined, env, "bearer-1");
    expect(label).toBe("Cursor");
  });

  it("resolves a legacy grant with no clientName through unwrapToken and lookupClient", async () => {
    const unwrapToken = vi.fn().mockResolvedValue({ grant: { clientId: "client-abc" } });
    const lookupClient = vi.fn().mockResolvedValue({ clientName: "Legacy Client" });
    const env = envWithOauth({ unwrapToken, lookupClient });

    const label = await resolveClientLabel({}, undefined, env, "bearer-legacy");
    expect(label).toBe("Legacy Client");
    expect(unwrapToken).toHaveBeenCalledWith("bearer-legacy");
    expect(lookupClient).toHaveBeenCalledWith("client-abc");
  });

  it("memoizes the legacy lookup per isolate by a hash of the token", async () => {
    const unwrapToken = vi.fn().mockResolvedValue({ grant: { clientId: "client-abc" } });
    const lookupClient = vi.fn().mockResolvedValue({ clientName: "Legacy Client" });
    const env = envWithOauth({ unwrapToken, lookupClient });

    await resolveClientLabel({}, undefined, env, "bearer-legacy");
    await resolveClientLabel({}, undefined, env, "bearer-legacy");
    expect(unwrapToken).toHaveBeenCalledTimes(1);
    expect(lookupClient).toHaveBeenCalledTimes(1);
  });

  it("skips the legacy lookup entirely for a static-token grant", async () => {
    const unwrapToken = vi.fn().mockResolvedValue({ grant: { clientId: "client-abc" } });
    const env = envWithOauth({ unwrapToken });

    const label = await resolveClientLabel({ via: "token" }, undefined, env, "static-bearer");
    expect(label).toBeNull();
    expect(unwrapToken).not.toHaveBeenCalled();
  });

  it("falls back to _meta clientInfo name when no grant name exists", async () => {
    const env = envWithOauth();
    const extra = { _meta: { "io.modelcontextprotocol/clientInfo": { name: "Meta Client" } } };
    const label = await resolveClientLabel({ via: "token" }, extra, env, "static-bearer");
    expect(label).toBe("Meta Client");
  });

  it("falls back to ?client= on the request URL when no meta name exists", async () => {
    const env = envWithOauth();
    const extra = { requestInfo: { url: "https://brain.example/mcp?client=codex" } };
    const label = await resolveClientLabel({ via: "token" }, extra, env, "static-bearer");
    expect(label).toBe("codex");
  });

  it("returns null when nothing resolves", async () => {
    const env = envWithOauth();
    const label = await resolveClientLabel({ via: "token" }, undefined, env, "static-bearer");
    expect(label).toBeNull();
  });

  it("clamping strips control characters and angle brackets and caps at 48", async () => {
    const env = envWithOauth();
    const raw = `<script>${"x".repeat(60)}\u0007`;
    const label = await resolveClientLabel({ clientName: raw }, undefined, env, "bearer-1");
    expect(label).not.toBeNull();
    expect(label).not.toMatch(/[<>]/);
    expect(label).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(label!.length).toBeLessThanOrEqual(48);
  });

  it("an empty result after clamping counts as absent and falls through", async () => {
    const env = envWithOauth();
    const extra = { _meta: { "io.modelcontextprotocol/clientInfo": { name: "Real Client" } } };
    const label = await resolveClientLabel({ clientName: "   " }, extra, env, "bearer-1");
    expect(label).toBe("Real Client");
  });
});
