#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required value: ${name}`);
  }
  return value;
}

function setBindingId(config, section, binding, idKey, value) {
  const bindings = config[section];
  if (!Array.isArray(bindings)) {
    throw new Error(`Expected ${section} to be an array`);
  }

  const matches = bindings.filter((item) => item?.binding === binding);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${section} binding named ${binding}`);
  }
  matches[0][idKey] = value;
}

export function buildDeployConfig(sourceConfig, ids, sourceName = "wrangler.jsonc") {
  const config = structuredClone(sourceConfig);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Expected ${sourceName} to contain a JSON object`);
  }

  const accountId = requiredString(ids.accountId, "CLOUDFLARE_ACCOUNT_ID");
  const databaseId = requiredString(ids.databaseId, "D1_DATABASE_ID");
  const oauthKvNamespaceId = requiredString(ids.oauthKvNamespaceId, "OAUTH_KV_NAMESPACE_ID");

  config.account_id = accountId;
  setBindingId(config, "d1_databases", "DB", "database_id", databaseId);
  setBindingId(config, "kv_namespaces", "OAUTH_KV", "id", oauthKvNamespaceId);
  return config;
}

export function readDeployConfig(inputPath = "wrangler.jsonc") {
  const absolute = resolve(inputPath);
  const { rawConfig } = experimental_readRawConfig(
    { config: absolute },
    { useRedirectIfAvailable: false },
  );
  return rawConfig;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const inputPath = resolve(process.argv[2] ?? "wrangler.jsonc");
  const outputPath = resolve(process.argv[3] ?? "wrangler.deploy.json");
  const config = buildDeployConfig(readDeployConfig(inputPath), {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: process.env.D1_DATABASE_ID,
    oauthKvNamespaceId: process.env.OAUTH_KV_NAMESPACE_ID,
  }, inputPath);

  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Wrote deploy config to ${outputPath}`);
}
