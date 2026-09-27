#!/usr/bin/env node
'use strict';
// sessionStart hook for the Cursor editor: recall injection.
//
// Per the 2026-09-26 hooks survey and the director's 2026-09-27 spot-check:
// Cursor's sessionStart can return `additional_context`, but it is explicitly
// fire-and-forget: the model loop does not wait for it. A recall slower than
// the first model turn can arrive too late, so this hook runs on a short,
// explicit cap rather than Claude Code's original 15s/3s budget (see
// DEFAULT_RECALL_TIMEOUT_MS in agent-hooks-core/core.js). before-submit-
// prompt.js is the synchronous safety net for the same context, and the two
// share a "delivered" marker so the context is not sent twice in one session.
//
// Cursor's sessionStart stdin field names are undocumented; this reads them
// defensively (sessionId before session_id, cwd as-is). No confirmed
// source/reason taxonomy for sessionStart was found either, so every call is
// treated as a fresh startup; there is no skip-list here the way Claude Code
// and Codex skip resume/fork on their SessionStart, because Cursor's fetched
// docs never named an equivalent reason for this event. UNVERIFIED against a
// real Cursor session; see README.md's "Unverified" section.
const { readStdinJson, performRecall, setMarker, fail } = require('../agent-hooks-core/core');

const NAMESPACE = 'cursor';
// Distinct from NAMESPACE on purpose: this key names the session-start/
// before-submit-prompt "already delivered" marker, never the recall content
// cache performRecall keeps under NAMESPACE itself, so the two never collide.
const DELIVERED_KEY = 'cursor-delivered';
const CAP_MS = 3000;

/**
 * Cursor's sessionStart stdin payload, normalized.
 *
 * The identity field is `conversation_id`, not `session_id`: verified
 * against https://cursor.com/docs/agent/hooks (checked 2026-09-27), which
 * lists `conversation_id` and `generation_id` as COMMON fields present on
 * every documented hook event (sessionStart, sessionEnd, beforeSubmitPrompt,
 * stop, and the rest), while `session_id` is only added on sessionStart and
 * sessionEnd specifically. A budget audit caught this hook (and
 * before-submit-prompt.js, which shares this function) reading only
 * sessionId/session_id: on the real beforeSubmitPrompt payload, which has
 * neither, the once-per-session marker could never be named, so every
 * prompt ran a full recall. `conversation_id` is used everywhere in this
 * adapter for exactly this reason: it is the one field every event these
 * hooks handle actually carries, so the same logical session always maps to
 * the same marker regardless of which event fired. `session_id`/`sessionId`
 * are kept as a defensive fallback only.
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
 * The testable main flow: normalize the payload, run the shared recall on the
 * short cap, mark delivery and emit only when there is something to deliver.
 * `overrides` is forwarded into performRecall (env, configPath, cacheDir …) so
 * a test can supply all of it without touching the real filesystem or network;
 * `overrides.cacheDir` is also used directly for the marker, so a test cache
 * dir applies to both. Returns the recalled text ('' or null for nothing to
 * print, matching performRecall's own contract).
 */
async function runSessionStart(payload, overrides = {}) {
  const { sessionId, cwd } = normalizeStdin(payload);
  const text = await performRecall({
    cwd,
    sessionId,
    source: 'startup',
    namespace: NAMESPACE,
    capMs: CAP_MS,
    ...overrides,
  });
  if (text) {
    setMarker(DELIVERED_KEY, sessionId, overrides.cacheDir);
    emitAdditionalContext(text);
  }
  return text;
}

async function main() {
  const payload = await readStdinJson();
  await runSessionStart(payload);
}

module.exports = {
  NAMESPACE, DELIVERED_KEY, CAP_MS,
  normalizeStdin, emitAdditionalContext, runSessionStart, main,
};

if (require.main === module) {
  main().catch((e) => fail(`recall failed: ${e?.message ?? e}`));
}
