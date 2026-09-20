import { describe, it, expect } from "vitest";
import { makeMemoryKV } from "../helpers/make-env";
import { loadIntegration, updateIntegration, type IntegrationRecord } from "../../src/integrations/framework";

function seed(config: Record<string, unknown> = {}): IntegrationRecord {
  return {
    provider: "notion",
    authKind: "token",
    credentials: { token: "secret" },
    config,
    status: "connected",
    workspaceName: "ws",
    lastSyncedAt: null,
    lastSyncError: null,
    itemMap: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("updateIntegration", () => {
  it("applies the mutator to a freshly loaded record, not a caller-held one", async () => {
    const env = { OAUTH_KV: makeMemoryKV() };
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(seed({ mirrorWorkspace: "personal" })));
    // A stale in-memory copy, then a concurrent layer change written straight to KV.
    const stale = await loadIntegration(env, "notion");
    expect(stale!.config.mirrorWorkspace).toBe("personal");
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(seed({ mirrorWorkspace: "company" })));

    const saved = await updateIntegration(env, "notion", (r) => { r.lastSyncedAt = 111; });

    expect(saved!.config.mirrorWorkspace).toBe("company"); // the concurrent write survives
    expect(saved!.lastSyncedAt).toBe(111);
    const persisted = await loadIntegration(env, "notion");
    expect(persisted!.config.mirrorWorkspace).toBe("company");
    expect(persisted!.lastSyncedAt).toBe(111);
  });

  it("returns null and writes nothing when the record was deleted", async () => {
    const env = { OAUTH_KV: makeMemoryKV() };
    const mutated = { called: false };
    const out = await updateIntegration(env, "notion", (r) => { mutated.called = true; r.updatedAt = 1; });
    expect(out).toBeNull();
    expect(mutated.called).toBe(false);
    expect(await env.OAUTH_KV.get("integrations:notion")).toBeNull();
  });
});
