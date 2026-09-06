import { describe, expect, it } from "vitest";
import { buildDeployConfig, readDeployConfig } from "../../scripts/write-deploy-config.mjs";

const ids = {
  accountId: "account-id",
  databaseId: "database-id",
  oauthKvNamespaceId: "oauth-kv-id",
};

describe("deploy Wrangler config", () => {
  it("parses JSONC and injects resource IDs without dropping custom bindings", () => {
    const sourceConfig = readDeployConfig("wrangler.jsonc");
    const config = buildDeployConfig(sourceConfig, ids);

    expect(config.account_id).toBe("account-id");
    expect(config.d1_databases).toContainEqual(expect.objectContaining({
      binding: "DB",
      database_id: "database-id",
    }));
    expect(config.kv_namespaces).toContainEqual(expect.objectContaining({
      binding: "OAUTH_KV",
      id: "oauth-kv-id",
    }));
    expect(config.send_email).toContainEqual({
      name: "RELEASE_EMAIL",
      destination_address: "dan@infoaddict.net",
    });
    expect(config.secrets.required).toEqual(["AUTH_TOKEN", "RELEASE_NOTIFY_TOKEN"]);
    expect(config.triggers).toEqual(sourceConfig.triggers);
  });

  it("fails closed when an expected binding is absent", () => {
    expect(() => buildDeployConfig({}, ids)).toThrow("d1_databases");
  });
});
