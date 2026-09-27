#!/usr/bin/env node
'use strict';
// SessionStart hook for Codex CLI: recall injection. SessionEnd capture lives
// in session-end.js and capture-worker.js alongside this file (see README.md).
//
// Codex's hook system is documented (per the 2026-09-26 hooks survey) as
// closely modeled on Claude Code's own: same lifecycle event names
// (SessionStart with reasons startup/resume/clear/compact) and the same
// stdout contract, JSON with hookSpecificOutput.additionalContext. The exact
// stdin field casing was not pinned down in the fetched vendor docs, so
// normalizeStartEvent below reads it defensively rather than assuming Claude's
// exact names are correct. UNVERIFIED against a real Codex CLI session.
const { readStdinJson, performRecall, fail } = require('../agent-hooks-core/core');

// resume and fork transcripts already carry the earlier injection (same
// reasoning as every other adapter in this repo). compact reruns SessionStart
// and discards what was injected before, so it is not skipped.
const SKIP_SOURCES = new Set(['resume', 'fork']);

/**
 * Maps a Codex SessionStart stdin payload onto the plain { sessionId, cwd,
 * source } shape performRecall takes. Field names are tried defensively:
 * session_id then sessionId for the id, cwd as-is, source then reason for why
 * this run happened, defaulting to startup when neither is present. UNVERIFIED
 * - see README.md's "Unverified" list.
 */
function normalizeStartEvent(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const sessionId = typeof p.session_id === 'string' ? p.session_id
    : typeof p.sessionId === 'string' ? p.sessionId : '';
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  const source = typeof p.source === 'string' ? p.source
    : typeof p.reason === 'string' ? p.reason : 'startup';
  return { sessionId, cwd, source };
}

/**
 * Writes the documented SessionStart output shape (hookSpecificOutput on
 * stdout, the vendor's own field name, chosen over plain stdout text because
 * it is unambiguous). No-op, and no stdout at all, for empty text.
 */
function emitAdditionalContext(text) {
  if (!text) return false;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  })}\n`);
  return true;
}

/**
 * The testable main flow: normalize the payload, run the shared recall, emit
 * the result. `overrides` is forwarded straight into performRecall, so a test
 * can supply env, configPath, cacheDir or capMs without touching the real
 * filesystem or the network. Returns the recalled text ('' or null for
 * nothing to print, matching performRecall's own contract).
 */
async function runSessionStart(payload, overrides = {}) {
  const { sessionId, cwd, source } = normalizeStartEvent(payload);
  const text = await performRecall({
    cwd,
    sessionId,
    source,
    skipSources: SKIP_SOURCES,
    namespace: 'codex',
    ...overrides,
  });
  if (text) emitAdditionalContext(text);
  return text;
}

async function main() {
  const payload = await readStdinJson();
  await runSessionStart(payload);
}

module.exports = { SKIP_SOURCES, normalizeStartEvent, emitAdditionalContext, runSessionStart, main };

if (require.main === module) {
  main().catch((e) => fail(`recall failed: ${e?.message ?? e}`));
}
