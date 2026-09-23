#!/usr/bin/env node
/**
 * Pretty-prints GET /brief against a live brain. Built for checking brief
 * v2's resurface and open-loops changes on a real deployment without the
 * dashboard — a `wrangler versions upload` preview URL, or production.
 *
 * No dependencies: fetch and fs are all Node needs.
 *
 * USAGE
 *   node scripts/brief-preview.mjs [--url <override>] [--live-state] [--dry-run [N]]
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
 *
 * --dry-run [N] additionally calls GET /extract/dry-run?limit=N (N defaults
 * to 5, admin-only, server clamps to 10) and prints the when-extraction
 * pass's verdict on each of the next N candidates past its own cursor —
 * without persisting anything or moving that cursor. This is the way to
 * judge extraction quality against the live brain before trusting the
 * nightly pass with it.
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
console.log(`  due:       ${data.attention?.due ?? 0}`);

let due;
try {
  due = await fetch(`${baseUrl}/due`, { headers: { Authorization: `Bearer ${token}` } });
} catch (e) {
  console.error(`\nRequest to ${baseUrl}/due failed: ${e.message}`);
  process.exit(1);
}
if (!due.ok) {
  console.error(`\nGET /due against ${baseUrl} answered ${due.status} ${due.statusText}`);
  process.exit(1);
}
const dueData = await due.json();
if (!dueData.ok) {
  console.error(`\nGET /due answered ok:false — ${dueData.error || "no error given"}`);
  process.exit(1);
}

console.log("\nDue:");
console.log(`  overdue: ${dueData.counts?.overdue ?? 0}`);
for (const item of dueData.overdue ?? []) {
  console.log(`  - [${item.id}] ${clip(item.content, 100)} (${item.when_kind}, ${item.when_source})`);
}
console.log(`  upcoming: ${dueData.counts?.upcoming ?? 0}`);
for (const item of dueData.upcoming ?? []) {
  console.log(`  - [${item.id}] ${clip(item.content, 100)} (${item.when_kind}, ${item.when_source})`);
}

if (flag("dry-run")) {
  const limit = arg("dry-run") || "5";
  let dryRun;
  try {
    dryRun = await fetch(`${baseUrl}/extract/dry-run?limit=${encodeURIComponent(limit)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    console.error(`\nRequest to ${baseUrl}/extract/dry-run failed: ${e.message}`);
    process.exit(1);
  }
  if (!dryRun.ok) {
    console.error(`\nGET /extract/dry-run against ${baseUrl} answered ${dryRun.status} ${dryRun.statusText}`);
    process.exit(1);
  }
  const dryRunData = await dryRun.json();
  if (!dryRunData.ok) {
    console.error(`\nGET /extract/dry-run answered ok:false — ${dryRunData.error || "no error given"}`);
    process.exit(1);
  }

  console.log(`\nExtraction dry run (next ${limit} candidates past the cursor, nothing persisted):`);
  for (const c of dryRunData.candidates ?? []) {
    console.log(`  - [${c.id}] ${c.outcome}`);
    console.log(`      content    ${clip(c.content, 100)}`);
    if (c.outcome === "commitment") {
      console.log(`      what       ${c.what}`);
      console.log(`      due_at     ${new Date(c.due_at).toISOString().slice(0, 10)}`);
      console.log(`      confidence ${c.confidence}`);
    }
  }
  if (!dryRunData.candidates?.length) console.log("  (no candidates past the cursor)");
}
