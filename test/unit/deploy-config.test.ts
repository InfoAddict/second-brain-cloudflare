import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildDeployConfig } from "../../scripts/write-deploy-config.mjs";

const ids = {
  accountId: "account-id",
  databaseId: "database-id",
  oauthKvNamespaceId: "oauth-kv-id",
};

describe("deploy Wrangler config", () => {
  it("parses JSONC and injects resource IDs without dropping custom bindings", () => {
    const config = buildDeployConfig(readFileSync("wrangler.jsonc", "utf8"), ids);

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
    expect(config.triggers.crons).toEqual(["0 1 * * *", "30 * * * *"]);
  });

  it("fails closed when an expected binding is absent", () => {
    expect(() => buildDeployConfig("{}", ids)).toThrow("d1_databases");
  });
});
