import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export const LIVE_VERIFY_ATTEMPTS = 5;
export const LIVE_VERIFY_TIMEOUT_SECONDS = 10;
export const LIVE_VERIFY_RETRY_DELAY_MS = 3_000;

export class LiveHealthError extends Error {}

function curlConfigValue(value) {
  if (/[\r\n]/.test(value)) throw new LiveHealthError("transport configuration is invalid");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function healthUrl(baseUrl) {
  if (!baseUrl) throw new LiveHealthError("live health URL is missing");
  return `${baseUrl.replace(/\/$/, "")}/health`;
}

export function requestHealthWithCurl({ baseUrl, token, runCurl = spawnSync }) {
  if (!token) throw new LiveHealthError("live health token is missing");

  const marker = "__SECOND_BRAIN_HTTP_STATUS__";
  const config = [
    `url = ${curlConfigValue(healthUrl(baseUrl))}`,
    `header = ${curlConfigValue(`Authorization: Bearer ${token}`)}`,
  ].join("\n");
  const result = runCurl("curl", [
    "--config", "-",
    "--silent",
    "--show-error",
    "--max-time", String(LIVE_VERIFY_TIMEOUT_SECONDS),
    "--write-out", `\\n${marker}%{http_code}`,
  ], { encoding: "utf8", input: config });

  if (result.error || result.status !== 0) {
    throw new LiveHealthError(`transport ${result.error?.code ?? `exit-${result.status ?? "unknown"}`}`);
  }

  const output = result.stdout ?? "";
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex === -1) throw new LiveHealthError("transport did not return an HTTP status");
  const status = Number(output.slice(markerIndex + marker.length).trim());
  if (!Number.isInteger(status)) throw new LiveHealthError("transport returned an invalid HTTP status");
  if (status !== 200) throw new LiveHealthError(`HTTP ${status}`);

  try {
    return JSON.parse(output.slice(0, markerIndex).trim());
  } catch {
    throw new LiveHealthError("invalid health response");
  }
}

export async function verifyLiveWorker({
  baseUrl,
  token,
  expectedVersion,
  attempts = LIVE_VERIFY_ATTEMPTS,
  requestHealth = requestHealthWithCurl,
  wait = sleep,
  log = console.log,
}) {
  if (!expectedVersion) throw new LiveHealthError("expected Worker version is missing");

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now();
    try {
      const health = await requestHealth({ baseUrl, token });
      if (health?.ok !== true) throw new LiveHealthError("health response is not ok:true");
      if (health.version !== expectedVersion) {
        throw new LiveHealthError(`expected Worker v${expectedVersion}; received v${String(health.version)}`);
      }
      log(`Live health attempt ${attempt}/${attempts} succeeded in ${Date.now() - startedAt}ms: v${health.version}`);
      return health;
    } catch (error) {
      lastError = error instanceof LiveHealthError ? error : new LiveHealthError("transport failure");
      log(`Live health attempt ${attempt}/${attempts} failed after ${Date.now() - startedAt}ms: ${lastError.message}`);
      if (attempt < attempts) await wait(LIVE_VERIFY_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

function expectedVersionFromSource() {
  return readFileSync("src/env.ts", "utf8").match(/SB_VERSION\s*=\s*"([^"]+)"/)?.[1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await verifyLiveWorker({
      baseUrl: process.env.SECOND_BRAIN_URL,
      token: process.env.SECOND_BRAIN_TOKEN,
      expectedVersion: expectedVersionFromSource(),
    });
  } catch (error) {
    console.error(`::error::Live Worker verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
