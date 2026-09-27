#!/usr/bin/env node
'use strict';
// `install.sh --check`: prove the hooks can reach the Worker, show what
// session-start would print, and report capture status.
const core = require('../agent-hooks-core/core');
const start = require('./session-start');

async function main() {
  const creds = core.loadCredentials();
  if (!creds) { console.error(`No credentials: set SECOND_BRAIN_URL/SECOND_BRAIN_TOKEN or write ${core.CONFIG_PATH}`); process.exit(1); }
  const res = await core.fetchWithTimeout(`${creds.baseUrl}/health`, { headers: { Authorization: `Bearer ${creds.token}` } }, 10000);
  if (!res.ok) { console.error(`GET /health -> HTTP ${res.status}. Token or URL is wrong.`); process.exit(1); }
  const health = await res.json();
  const captureOn = core.captureEnabled(process.env, 'SECOND_BRAIN_HOOK_CAPTURE_CURSOR');
  const last = core.lastCaptureTime('cursor', core.CACHE_DIR);
  const pending = core.readCaptureSpool('cursor', core.CACHE_DIR).length;
  console.log(`Worker ${health.version} at ${creds.baseUrl} - recall: on; session capture: ${captureOn ? 'on' : 'off'}`);
  console.log(`last capture: ${last ? new Date(last).toISOString() : 'never'}`);
  console.log(`captures waiting to retry (spooled after a failed upload): ${pending}`);

  console.log('\n-- session-start against this brain --');
  await start.main();
  if (process.exitCode) process.exit(process.exitCode);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
