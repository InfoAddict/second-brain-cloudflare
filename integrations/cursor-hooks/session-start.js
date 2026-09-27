#!/usr/bin/env node
'use strict';
// sessionStart hook for the Cursor editor: recall injection.
//
// sessionStart's `additional_context` is the one hook output Cursor's docs
// say reaches the model: "Additional context to add to the conversation's
// initial system context" (https://prod.cursor.com/docs/hooks). The hook is
// fire-and-forget ("the agent loop does not wait for or enforce a blocking
// response"), so a slow recall can land after the first turn; it runs on a
// short cap for that reason. There is no second delivery path: the earlier
// beforeSubmitPrompt fallback was removed, because that event's
// `user_message` is only "shown to the user when the prompt is blocked" and
// never reaches the model. The README points users to the MCP `recall` tool
// as the reliable path.
//
// After recall is printed, any kept captures from an earlier failed
// session-end are retried inside what is left of the same cap; the host is
// not waiting on this hook, so that retry never delays the conversation.
const { readStdinJson, performRecall, flushCaptureSpool, fail } = require('../agent-hooks-core/core');

const NAMESPACE = 'cursor';
const CAP_MS = 3000;

/**
 * Cursor's sessionStart stdin payload, normalized.
 *
 * The identity field is `conversation_id`, which the docs list as a common
 * field on every event (`session_id` is only on sessionStart and sessionEnd).
 * session-end.js shares this function, so `stop` and `sessionEnd` for one
 * conversation map to the same cache key and capture marker.
 * `session_id`/`sessionId` are a defensive fallback only.
 *
 * `cwd` prefers the documented `workspace_roots` input: a review caught this
 * hook falling back to `process.cwd()` even when workspace_roots was
 * present, which is wrong for a project because Cursor's own hooks run from
 * the user's ~/.cursor directory, not the project - process.cwd() there is
 * never the project. workspace_roots[0] is the project the session is
 * actually in; `cwd` itself and process.cwd() are fallbacks for whenever it
 * is absent.
 */
function normalizeStdin(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const sessionId = typeof p.conversation_id === 'string' ? p.conversation_id
    : typeof p.conversationId === 'string' ? p.conversationId
    : typeof p.sessionId === 'string' ? p.sessionId
    : typeof p.session_id === 'string' ? p.session_id : '';
  const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots
    : Array.isArray(p.workspaceRoots) ? p.workspaceRoots : [];
  const root = typeof roots[0] === 'string' && roots[0] ? roots[0] : '';
  const cwd = root || (typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd());
  return { sessionId, cwd };
}

/**
 * The documented sessionStart output shape: a FLAT `additional_context` field
 * on stdout, unlike the nested `hookSpecificOutput.additionalContext` the
 * Codex/Gemini/Copilot family uses. No-op, and no stdout at all, for empty text.
 */
function emitAdditionalContext(text) {
  if (!text) return false;
  process.stdout.write(`${JSON.stringify({ additional_context: text })}\n`);
  return true;
}

/**
 * The testable main flow: recall on the short cap, print it, then retry kept
 * captures inside what is left of the cap. `overrides` (env, configPath,
 * cacheDir) lets a test run this without the real filesystem or network.
 */
async function runSessionStart(payload, overrides = {}) {
  const started = Date.now();
  const { sessionId, cwd } = normalizeStdin(payload);
  const text = await performRecall({
    cwd,
    sessionId,
    source: 'startup',
    namespace: NAMESPACE,
    capMs: CAP_MS,
    ...overrides,
  });
  if (text) emitAdditionalContext(text);
  await flushCaptureSpool({
    env: overrides.env, configPath: overrides.configPath, cacheDir: overrides.cacheDir,
    namespace: NAMESPACE, deadline: started + (overrides.capMs ?? CAP_MS),
  });
  return text;
}

async function main() {
  const payload = await readStdinJson();
  await runSessionStart(payload);
}

module.exports = {
  NAMESPACE, CAP_MS,
  normalizeStdin, emitAdditionalContext, runSessionStart, main,
};

if (require.main === module) {
  main().catch((e) => fail(`recall failed: ${e?.message ?? e}`));
}
