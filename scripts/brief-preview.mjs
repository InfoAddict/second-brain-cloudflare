#!/usr/bin/env node
/**
 * Pretty-prints GET /brief against a live brain. Built for checking brief
 * v2's resurface and open-loops changes on a real deployment without the
 * dashboard — a `wrangler versions upload` preview URL, or production.
 *
 * No dependencies: fetch and fs are all Node needs.
 *
 * USAGE
 *   node scripts/brief-preview.mjs [--url <override>] [--live-state]
 *
 * Credentials come from ~/.config/second-brain/config.json's
 * { workerUrl, authToken } — the same file the CLI and desktop installer
 * already share (see integrations/claude-code-hooks/common.js's
 * loadCredentials for the sibling reader). --url overrides workerUrl only,
 * for pointing at a preview deployment's own origin without touching the
 * config file; the auth token is the same across a preview and production
 * (same D1, same bindings), so it always comes from the file.
 *
 * Defaults to `?preview=1`: GET /brief's preview mode runs the identical read
 * path but skips the resurface state's KV write (src/routes/brief.ts), so
 * running this repeatedly against the LIVE brain — the whole point of a
 * preview check — never disturbs production's actual daily rotation.
 * --live-state exercises the real, stateful path instead, for confirming the
 * KV write itself.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

const CONFIG_PATH = join(homedir(), ".config", "second-brain", "config.json");

function loadConfig() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (cfg && typeof cfg.workerUrl === "string" && typeof cfg.authToken === "string") {
      return { workerUrl: cfg.workerUrl, authToken: cfg.authToken };
    }
  } catch {
    // Absent or malformed — the caller decides whether --url alone is enough.
  }
  return null;
}

const stripSlash = (u) => String(u).trim().replace(/\/+$/, "");

const cfg = loadConfig();
const baseUrl = stripSlash(arg("url") || cfg?.workerUrl || "");
const token = cfg?.authToken || "";

if (!baseUrl || !token) {
  console.error(
    `Need a Worker URL and an auth token. Set both in ${CONFIG_PATH} ` +
      `({ "workerUrl": ..., "authToken": ... }), or pass --url to override ` +
      "just the URL (the token still comes from that file).",
  );
  process.exit(1);
}

const path = flag("live-state") ? "/brief" : "/brief?preview=1";

let res;
try {
  res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
} catch (e) {
  console.error(`Request to ${baseUrl}${path} failed: ${e.message}`);
  process.exit(1);
}

if (!res.ok) {
  console.error(`GET ${path} against ${baseUrl} answered ${res.status} ${res.statusText}`);
  try {
    console.error(await res.text());
  } catch {
    // Body already consumed or unreadable — the status line above is enough.
  }
  process.exit(1);
}

const data = await res.json();
if (!data.ok) {
  console.error(`GET ${path} answered ok:false — ${data.error || "no error given"}`);
  process.exit(1);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ageDays = (createdAt) => Math.floor((Date.now() - createdAt) / DAY_MS);
const clip = (s, n) => (s || "").slice(0, n);

console.log(`Second Brain — GET ${path}`);
console.log(`  ${baseUrl}`);
console.log("=".repeat(60));

console.log("\nResurface pick:");
if (data.resurface) {
  const r = data.resurface;
  console.log(`  id      ${r.id}`);
  console.log(`  age     ${ageDays(r.created_at)} days`);
  console.log(`  tags    ${(r.tags || []).join(", ") || "(none)"}`);
  console.log(`  content ${clip(r.content, 120)}`);
} else {
  console.log("  (none)");
}

console.log("\nOpen loops:");
console.log(`  open: ${data.loops?.open ?? 0}`);
for (const item of data.loops?.items ?? []) {
  console.log(`  - [${item.id}] ${clip(item.content, 100)}`);
}

console.log("\nPatterns awaiting a decision:");
console.log(`  ${(data.patterns || []).length}`);

console.log("\nAttention:");
console.log(`  unindexed: ${data.attention?.unindexed ?? 0}`);
console.log(`  stale:     ${data.attention?.stale ?? 0}`);
console.log(`  patterns:  ${data.attention?.patterns ?? 0}`);
