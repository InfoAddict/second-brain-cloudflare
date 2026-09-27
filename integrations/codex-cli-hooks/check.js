#!/usr/bin/env node
'use strict';
// `install.sh --check`: prove the hooks can reach the Worker, show what
// session-start would recall, report whether capture is turned on, and when
// it last actually ran.
const path = require('node:path');
const {
  loadCredentials, fetchWithTimeout, lastCaptureTime, captureEnabled, readCaptureSpool, CONFIG_PATH,
} = require('../agent-hooks-core/core');
const start = require('./session-start');
const worker = require('./capture-worker');

const PER_CLIENT_ENV_VAR = worker.PER_CLIENT_ENV_VAR;

async function main() {
  const creds = loadCredentials();
  if (!creds) {
    console.error(`No credentials: set SECOND_BRAIN_URL/SECOND_BRAIN_TOKEN or write ${CONFIG_PATH}`);
    process.exit(1);
  }
  const res = await fetchWithTimeout(`${creds.baseUrl}/health`, { headers: { Authorization: `Bearer ${creds.token}` } }, 10000);
  if (!res.ok) { console.error(`GET /health → HTTP ${res.status}. Token or URL is wrong.`); process.exit(1); }
  const health = await res.json();
  const major = parseInt(String(health.version ?? '').split('.')[0], 10);
  console.log(`Worker ${health.version} at ${creds.baseUrl} - recall: on; session capture: ${major >= 3 ? 'on' : 'off (needs 3.0+)'}`);

  const capOn = captureEnabled(process.env, PER_CLIENT_ENV_VAR);
  console.log(`Capture toggles: SECOND_BRAIN_HOOK_CAPTURE=${process.env.SECOND_BRAIN_HOOK_CAPTURE ?? '(unset)'} ${PER_CLIENT_ENV_VAR}=${process.env[PER_CLIENT_ENV_VAR] ?? '(unset)'} → ${capOn ? 'on' : 'off'}`);
  const last = lastCaptureTime(worker.NAMESPACE);
  console.log(`Last successful capture: ${last ? new Date(last).toISOString() : 'never'}`);
  const pending = readCaptureSpool(worker.NAMESPACE).length;
  console.log(`Captures waiting to retry (spooled after a failed upload): ${pending}`);

  console.log('\n- session-start against this brain -');
  await start.main();

  console.log('\n- session-end (capture-worker) dry run against the bundled sample transcript -');
  process.env.SECOND_BRAIN_DRY_RUN = '1';
  const fixture = path.join(__dirname, 'fixtures', 'sample-transcript.jsonl');
  const result = await worker.run({ transcriptPath: fixture, cwd: process.cwd(), sessionId: 'codex-check' }, { transcriptRoot: path.dirname(fixture) });
  console.log(JSON.stringify({ wouldCapture: result.sent || result.reason === 'dry-run', reason: result.reason }, null, 2));
  if (process.exitCode) process.exit(process.exitCode);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
