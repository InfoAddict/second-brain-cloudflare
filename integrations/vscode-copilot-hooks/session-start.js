#!/usr/bin/env node
'use strict';
// SessionStart hook for VS Code GitHub Copilot's LOCAL HARNESS ONLY. This is a
// different hooks system from GitHub Copilot CLI / cloud agent / Agent Host,
// which use camelCase fields and a separate reference doc entirely - see
// README.md's scope warning before wiring this into anything else.
//
// Recall-only, on purpose: capture (SessionEnd-equivalent) is out of scope for
// this adapter. The Local harness's closest analogue, `Stop`, fires when one
// agent execution is about to stop, not necessarily when the chat session
// ends, and its `transcript_path` payload is documented as an unstable shape.
// A capture hook built on it would need its own investigation; this file does
// not attempt one.
const core = require('../agent-hooks-core/core');
const { performRecall, readStdinJson, fail } = core;

// Best-guess parity with the Claude Code / Codex family: resume/fork
// transcripts already contain the earlier injection so those sources are
// skipped, while compact is not (compaction discards it). The Local harness's
// own source/reason values were not confirmed against a real session - see
// README.md's Unverified section.
const SKIP_SOURCES = new Set(['resume', 'fork']);

// Deliberate choice, not an oversight: VS Code Copilot Local's SessionStart is
// not documented anywhere (per the 2026-09-26 hooks survey) as running on a
// tight, synchronous clock the way Gemini CLI's or Cursor's hosts are, so
// there is no evidence-backed reason to trade recall away on a slow or cold
// Worker here. This inherits Claude Code's own 15s recall / 3s brief-grace
// budget on purpose - named explicitly below instead of leaving the call to
// performRecall() silently fall through to its defaults, so a future reader
// does not mistake the omission for one.
const RECALL_TIMEOUT_MS = core.DEFAULT_RECALL_TIMEOUT_MS;
const BRIEF_GRACE_MS = core.DEFAULT_BRIEF_GRACE_MS;

/**
 * Local harness stdin field names were not pinned letter-perfect in the
 * vendor docs fetched 2026-09-26, so this reads defensively: `session_id`
 * then `sessionId` for the id, `cwd` as-is, `source` then `reason` for why
 * this run happened. UNVERIFIED against a real VS Code Copilot Local session
 * - see README.md.
 */
function normalizeStdin(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const sessionId = typeof p.session_id === 'string' ? p.session_id
    : typeof p.sessionId === 'string' ? p.sessionId : '';
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  const source = typeof p.source === 'string' ? p.source
    : typeof p.reason === 'string' ? p.reason : 'startup';
  return { sessionId, cwd, source };
}

/**
 * The nested shape documented for SessionStart across the Codex/Gemini/Copilot
 * Local family: `hookSpecificOutput.additionalContext` on stdout.
 */
function buildHookOutput(text) {
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
}

async function main() {
  const payload = await readStdinJson();
  const { sessionId, cwd, source } = normalizeStdin(payload);
  const text = await performRecall({
    cwd,
    sessionId,
    source,
    skipSources: SKIP_SOURCES,
    namespace: 'vscode-copilot',
    recallTimeoutMs: RECALL_TIMEOUT_MS,
    briefGraceMs: BRIEF_GRACE_MS,
  });
  if (text) process.stdout.write(JSON.stringify(buildHookOutput(text)) + '\n');
}

module.exports = { SKIP_SOURCES, RECALL_TIMEOUT_MS, BRIEF_GRACE_MS, normalizeStdin, buildHookOutput, main };

if (require.main === module) {
  main().catch((e) => fail(`recall failed: ${e?.message ?? e}`));
}
