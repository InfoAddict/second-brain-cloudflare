#!/usr/bin/env node
'use strict';
// SessionEnd hook for Codex CLI: fast dispatcher only. Per the hard constraint
// this adapter was built against, Codex's SessionEnd hook is capped at a 1s
// default timeout and a 3s max (see install.sh's hooks.json entry and
// README.md's "Unverified" section) - nowhere near enough to read a
// transcript, call the Worker and wait on an embedding. So this file does the
// minimum possible: read stdin, decide whether there is anything to capture,
// and hand the real work to capture-worker.js in a DETACHED, unref'd child
// process that can keep running after this one exits and Codex moves on.
//
// Whether Codex actually lets that child outlive the parent hook process is
// UNVERIFIED - this is the one piece of this adapter that most needs a real
// smoke test (see README.md's smoke-test list).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readStdinJson, captureEnabled, fail } = require('../agent-hooks-core/core');

const PER_CLIENT_ENV_VAR = 'SECOND_BRAIN_HOOK_CAPTURE_CODEX';

/**
 * Maps a Codex SessionEnd stdin payload onto the fields capture-worker.js
 * needs. Field names are tried defensively, same reasoning as
 * session-start.js's normalizeStartEvent: the exact casing was not pinned
 * down in the fetched vendor docs. `reason` is documented (per the 2026-09-26
 * hooks survey) as one of close/archive/delete/idle - the shared core's
 * "already captured this session" marker means only the first of those four
 * to actually fire for a given session id ever posts, so this file does not
 * need to special-case any of them.
 */
function normalizeEndEvent(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const sessionId = typeof p.session_id === 'string' ? p.session_id
    : typeof p.sessionId === 'string' ? p.sessionId : '';
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path
    : typeof p.transcriptPath === 'string' ? p.transcriptPath : '';
  const reason = typeof p.reason === 'string' ? p.reason : 'other';
  return { sessionId, cwd, transcriptPath, reason };
}

/**
 * Spawns capture-worker.js detached and unref'd, passing the normalized
 * payload as its one argv entry (JSON-encoded - never the raw token or any
 * credential, those come from the environment the same way every other
 * adapter reads them). `spawnFn` and `workerPath` are only ever overridden by
 * tests, so production always spawns the real file next to this one.
 */
function dispatchCapture(payload, { spawnFn = spawn, workerPath = path.join(__dirname, 'capture-worker.js') } = {}) {
  const child = spawnFn(process.execPath, [workerPath, JSON.stringify(payload)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

async function main() {
  const payload = await readStdinJson();
  const normalized = normalizeEndEvent(payload);
  // Cheap checks only - this file is on the tight clock, capture-worker.js is not.
  if (!normalized.transcriptPath || !fs.existsSync(normalized.transcriptPath)) return;
  if (!captureEnabled(process.env, PER_CLIENT_ENV_VAR)) return;
  dispatchCapture(normalized);
}

module.exports = { PER_CLIENT_ENV_VAR, normalizeEndEvent, dispatchCapture, main };

if (require.main === module) {
  main().catch((e) => fail(`session capture dispatch failed: ${e?.message ?? e}`));
}
