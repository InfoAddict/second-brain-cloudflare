import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export const LIVE_VERIFY_ATTEMPTS = 5;
export const LIVE_VERIFY_TIMEOUT_SECONDS = 10;
export const LIVE_VERIFY_RETRY_DELAY_MS = 3_000;
export const CONFIG_WARMUP_TIMEOUT_SECONDS = 60;

export class LiveHealthError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.status = status;
  }
}

function curlConfigValue(value) {
  if (/[\r\n]/.test(value)) throw new LiveHealthError("transport configuration is invalid");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function workerBaseUrl(baseUrl) {
  if (!baseUrl) throw new LiveHealthError("live health URL is missing");
  return baseUrl.replace(/\/$/, "");
}

const CURL_METRICS_MARKER = "__SECOND_BRAIN_CURL_METRICS__";

export function parseCurlMetrics(output) {
  const markerIndex = output.lastIndexOf(CURL_METRICS_MARKER);
  if (markerIndex === -1) return undefined;

  const values = output.slice(markerIndex + CURL_METRICS_MARKER.length).trim().split(",");
  if (values.length !== 7 || !/^\d{3}$/.test(values[0])) return undefined;
  if (values.slice(1).some(value => !/^\d+(?:\.\d+)?$/.test(value))) return undefined;
  const numbers = values.slice(1).map(Number);
  if (numbers.some(value => !Number.isFinite(value) || value < 0)) return undefined;

  const [dns, connect, tls, startTransfer, total, downloaded] = numbers;
  return {
    body: output.slice(0, markerIndex),
    diagnostics: `HTTP ${values[0]}; dns=${dns}s connect=${connect}s tls=${tls}s starttransfer=${startTransfer}s total=${total}s downloaded=${downloaded}B`,
    status: Number(values[0]),
  };
}

function requestWithCurl({ baseUrl, token, path, timeoutSeconds, runCurl = spawnSync }) {
  if (!token) throw new LiveHealthError("live health token is missing");

  const config = [
    `url = ${curlConfigValue(`${workerBaseUrl(baseUrl)}${path}`)}`,
    `header = ${curlConfigValue(`Authorization: Bearer ${token}`)}`,
  ].join("\n");
  const result = runCurl("curl", [
    "--config", "-",
    "--silent",
    "--show-error",
    "--max-time", String(timeoutSeconds),
    "--write-out", `\\n${CURL_METRICS_MARKER}%{http_code},%{time_namelookup},%{time_connect},%{time_appconnect},%{time_starttransfer},%{time_total},%{size_download}`,
  ], { encoding: "utf8", input: config });

  const metrics = parseCurlMetrics(result.stdout ?? "");
  if (result.error || result.status !== 0) {
    throw new LiveHealthError(`transport ${result.error?.code ?? `exit-${result.status ?? "unknown"}`}${metrics ? `; ${metrics.diagnostics}` : ""}`, { status: metrics?.status });
  }

  if (!metrics) throw new LiveHealthError("transport returned invalid timing metrics");
  return metrics;
}

export function requestHealthWithCurl({ baseUrl, token, runCurl = spawnSync }) {
  const metrics = requestWithCurl({
    baseUrl,
    token,
    path: "/health",
    timeoutSeconds: LIVE_VERIFY_TIMEOUT_SECONDS,
    runCurl,
  });
  if (metrics.status !== 200) throw new LiveHealthError(metrics.diagnostics, { status: metrics.status });

  try {
    return JSON.parse(metrics.body.trim());
  } catch {
    throw new LiveHealthError("invalid health response");
  }
}

export function warmLiveWorkerConfig({ baseUrl, token, runCurl = spawnSync, log = console.log }) {
  const startedAt = Date.now();
  try {
    const metrics = requestWithCurl({
      baseUrl,
      token,
      path: "/config",
      timeoutSeconds: CONFIG_WARMUP_TIMEOUT_SECONDS,
      runCurl,
    });
    if (metrics.status !== 200) throw new LiveHealthError("config warmup returned a non-200 status", { status: metrics.status });
    log(`Live config warmup succeeded in ${Date.now() - startedAt}ms: HTTP ${metrics.status}`);
  } catch (error) {
    const status = error instanceof LiveHealthError ? error.status : undefined;
    log(`Live config warmup failed after ${Date.now() - startedAt}ms: ${status === undefined ? "transport failure" : `HTTP ${status}`}`);
    throw error;
  }
}

export async function verifyLiveWorker({
  baseUrl,
  token,
  expectedVersion,
  attempts = LIVE_VERIFY_ATTEMPTS,
  warmConfig = warmLiveWorkerConfig,
  requestHealth = requestHealthWithCurl,
  wait = sleep,
  log = console.log,
}) {
  if (!expectedVersion) throw new LiveHealthError("expected Worker version is missing");

  await warmConfig({ baseUrl, token, log });

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
