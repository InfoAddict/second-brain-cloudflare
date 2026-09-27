#!/usr/bin/env node
'use strict';
// `install.sh --check`: prove the hook can reach the Worker and show what it
// would print, without touching Gemini CLI itself.
const path = require('node:path');
const { loadCredentials, fetchWithTimeout, CONFIG_PATH } = require(path.join(__dirname, '..', 'agent-hooks-core', 'core.js'));
const start = require('./session-start');

async function main() {
  const creds = loadCredentials();
  if (!creds) { console.error(`No credentials: set SECOND_BRAIN_URL/SECOND_BRAIN_TOKEN or write ${CONFIG_PATH}`); process.exit(1); }
  const res = await fetchWithTimeout(`${creds.baseUrl}/health`, { headers: { Authorization: `Bearer ${creds.token}` } }, 10000);
  if (!res.ok) { console.error(`GET /health → HTTP ${res.status}. Token or URL is wrong.`); process.exit(1); }
  const health = await res.json();
  console.log(`Worker ${health.version} at ${creds.baseUrl} - recall: on (SessionStart only, no capture)`);

  console.log('\n— session-start against this brain —');
  await start.main();
  if (process.exitCode) process.exit(process.exitCode);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
