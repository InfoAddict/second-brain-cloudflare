#!/usr/bin/env node
'use strict';
// Gemini CLI SessionStart hook: recall injection only, no capture. Gemini's
// hooks run synchronously and the CLI waits on this process, and the vendor
// docs have no documented timeout ceiling for it (per the 2026-09-26 hooks
// survey) - so this adapter's own capMs below is the only thing standing
// between a Worker outage and an indefinitely hung terminal.
const path = require('node:path');
const {
  readStdinJson, fail, performRecall,
} = require(path.join(__dirname, '..', 'agent-hooks-core', 'core.js'));

// resume: the transcript already holds the earlier injection (same reasoning
// as every other adapter). startup/clear get a fresh recall. Gemini's docs
// give no `compact` (or equivalent) source and do not claim SessionStart
// reruns after compaction the way Codex's docs do for Codex - unlike the
// Codex adapter, this file does NOT assume a rerun-after-compaction path
// exists, so nothing here treats any source as that case. If a real Gemini
// CLI session shows a distinct post-compaction SessionStart source string,
// add it to SKIP_SOURCES or wire it into performRecall's cacheable-compact
// path then - not before, since that behavior is unverified.
const SKIP_SOURCES = new Set(['resume']);

// Strict ceiling for this adapter specifically (see the block above main()
// for why 3000 and not a moment more).
const CAP_MS = 3000;

/**
 * Gemini's stdin field names were confirmed against the vendor docs
 * (session_id, cwd, source) but the task brief still asks this to be read
 * defensively, so a renamed or camelCased field degrades to "no project /
 * generic recall" instead of throwing: session_id then sessionId; cwd as-is;
 * source then reason.
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
 * The exact JSON shape Gemini's SessionStart (and BeforeAgent) hooks read
 * context from - the same nested shape Codex and VS Code Copilot use. Gemini's
 * docs are explicit that only JSON belongs on stdout for this hook, so unlike
 * Codex there is no plain-text fallback here, and nothing is written at all
 * when there is no context to add (not even `{}`).
 */
function buildOutput(text) {
  if (!text) return '';
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: text,
    },
  })}\n`;
}

/*
 * Why capMs=3000 is provably a hard ceiling on the network portion of this
 * hook, re-checked against integrations/agent-hooks-core/core.js's
 * performRecall (read in full before writing this file):
 *
 *   - performRecall computes ONE deadline, `Date.now() + capMs`, before
 *     starting any request, and threads that single wall-clock target through
 *     everywhere a request could block.
 *   - The brief request runs behind an AbortController whose abort timer
 *     fires at `deadline`; `settle()` races the brief promise against a
 *     second timer set to the same `deadline`, so nothing ever waits on the
 *     brief past the cap.
 *   - Every recall attempt in the plan (the project arm, then the free-text
 *     fallback) is given `Math.max(0, deadline - Date.now())` as its OWN
 *     fetch timeout - a fixed shared target, not a fresh capMs per attempt -
 *     so two sequential recall requests cannot add up to more than capMs
 *     total.
 *   - Any hard failure (bad token, non-2xx, timeout, bad JSON) calls fail()
 *     and returns immediately; there is no retry loop that could push past
 *     the deadline.
 *
 *   The one thing capMs does NOT cover is the git remote lookup inside
 *   parseProjectName (gitRemoteUrl), which runs before the deadline is
 *   computed and carries its own separate execFileSync timeout (2000ms, set
 *   in core.js). That is a local, synchronous read of .git/config, not a
 *   network call, is identical for every existing adapter including
 *   claude-code-hooks, and is out of scope to change here since core.js is
 *   shared - but it does mean the true worst case is bounded by that 2s plus
 *   capMs, not by capMs alone. Documented in this adapter's README.
 */
async function main() {
  const payload = await readStdinJson();
  const { sessionId, cwd, source } = normalizeStdin(payload);
  const text = await performRecall({
    cwd,
    sessionId,
    source,
    namespace: 'gemini',
    skipSources: SKIP_SOURCES,
    capMs: CAP_MS,
  });
  if (text) process.stdout.write(buildOutput(text));
}

module.exports = { SKIP_SOURCES, CAP_MS, normalizeStdin, buildOutput, main };

if (require.main === module) {
  main().catch((e) => fail(`recall failed: ${e?.message ?? e}`));
}
