#!/usr/bin/env node
'use strict';
// Session-end capture for the Cursor editor.
//
// The survey found `transcript_path` in the shared base input schema but not
// confirmed on the `sessionEnd` or `stop` specifications specifically, so
// this one script is registered for BOTH events by install.sh/install.ps1 and
// simply no-ops (exit 0, no request) whenever the payload it receives has no
// usable transcript_path: expected when transcript storage is off, or when
// the event that fired is the one without it, not a failure. See README.md
// for why one script covers both events instead of two files.
//
// Cursor's own JSONL transcript format is undocumented and explicitly
// unstable, so this file owns a small, defensive parser rather than reusing
// Claude Code's or Codex's: never assume a shape, never throw on a line that
// does not match it, and skip anything that is not a plain human turn.
//
// Cursor's output on this event is ignored (per the survey), so unlike
// session-start.js / before-submit-prompt.js there is no stdout contract to
// build; performCapture's own DRY_RUN printing is the only thing this file
// ever writes to stdout.
const fs = require('node:fs');
const {
  readStdinJson, performCapture, gitRemoteUrl, parseProjectLabel, projectSlug, resolveWorkspace, fail,
  transcriptBelongsToSession,
} = require('../agent-hooks-core/core');

const NAMESPACE = 'cursor';
const PER_CLIENT_ENV_VAR = 'SECOND_BRAIN_HOOK_CAPTURE_CURSOR';
// A session worth capturing only needs its last few user turns (performCapture
// keeps 3), so a generous tail is plenty; this bounds memory on an unexpectedly
// huge or corrupt transcript instead of reading the whole thing unconditionally.
const READ_CEILING_BYTES = 2 * 1024 * 1024;

/**
 * A message's human-readable text, tried against every shape this undocumented
 * format might reasonably use: a plain string, an array of blocks with a
 * `text` field (or plain strings), or a single `{ text }` object. Nothing here
 * is assumed to be the one true shape: whichever matches wins, and content
 * that matches none of them yields ''.
 */
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * One JSONL line to a turn, or null when it is not a recognisable human turn.
 * Never throws: malformed or truncated JSON (a line cut off mid-write, the
 * realistic failure mode for a transcript file read right as a session ends)
 * is skipped, not fatal, and parsing continues with the next line.
 */
function turnFromLine(line) {
  if (!line || !line.trim()) return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const role = typeof obj.role === 'string' ? obj.role : typeof obj.type === 'string' ? obj.type : '';
  if (role !== 'user' && role !== 'assistant') return null;
  const text = textFromContent(obj.content ?? obj.message ?? obj.text).trim();
  return text ? { role, text } : null;
}

/**
 * The last `byteCeiling` bytes of `filePath`, or the whole file when it is
 * smaller. A line cut by the block boundary is discarded rather than parsed
 * half-formed, the same convention claude-code-hooks' own tail reader uses.
 */
function readTail(filePath, byteCeiling = READ_CEILING_BYTES) {
  const size = fs.statSync(filePath).size;
  if (size <= byteCeiling) return fs.readFileSync(filePath, 'utf8');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(byteCeiling);
    fs.readSync(fd, buf, 0, byteCeiling, size - byteCeiling);
    const text = buf.toString('utf8');
    const firstNl = text.indexOf('\n');
    return firstNl === -1 ? '' : text.slice(firstNl + 1);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * User-turn text only, oldest first: the exact shape performCapture's
 * `userTurns` wants. Assistant lines are still parsed (so a malformed
 * assistant line cannot throw) but dropped here; only performCapture decides
 * what belongs in the stored body.
 */
function readUserTurns(filePath) {
  const text = readTail(filePath);
  const turns = [];
  for (const line of text.split('\n')) {
    const t = turnFromLine(line);
    if (t && t.role === 'user') turns.push(t.text);
  }
  return turns;
}

async function main() {
  const payload = await readStdinJson();
  const p = payload && typeof payload === 'object' ? payload : {};
  const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path
    : typeof p.transcriptPath === 'string' ? p.transcriptPath : '';
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return; // no transcript on this event: not a failure

  // conversation_id, not session_id: verified against
  // https://cursor.com/docs/agent/hooks (checked 2026-09-27) - it is a common
  // field present on every event including sessionEnd AND stop, while
  // session_id is only added on sessionStart/sessionEnd (stop has no
  // session_id at all). This file is registered for both events, so it needs
  // the field both of them actually carry, and using the same field
  // session-start.js/before-submit-prompt.js key their marker on keeps one
  // logical session's capture-dedup identity consistent across all three
  // scripts regardless of which event fires. session_id/sessionId are kept
  // as a defensive fallback only.
  const sessionId = typeof p.conversation_id === 'string' ? p.conversation_id
    : typeof p.conversationId === 'string' ? p.conversationId
    : typeof p.sessionId === 'string' ? p.sessionId
    : typeof p.session_id === 'string' ? p.session_id : '';
  // A review demonstrated a capture worker (Codex's) handed a transcript_path
  // from an unrelated project's session: the same class of check applies
  // here, layout-agnostic for the same reason (see
  // transcriptBelongsToSession's own comment in agent-hooks-core/core.js).
  if (!transcriptBelongsToSession(transcriptPath, sessionId)) return;

  const userTurns = readUserTurns(transcriptPath);
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  const projectName = parseProjectLabel(gitRemoteUrl(cwd), cwd);
  const meta = {
    hostLabel: 'Cursor',
    project: projectSlug(projectName),
    projectName,
    timestamp: new Date().toISOString(),
    workspace: resolveWorkspace(),
    source: 'cursor-session',
  };
  await performCapture({ userTurns, meta, namespace: NAMESPACE, sessionId, perClientEnvVar: PER_CLIENT_ENV_VAR });
}

module.exports = { textFromContent, turnFromLine, readTail, readUserTurns, main };

if (require.main === module) {
  main().catch((e) => fail(`session capture failed: ${e?.message ?? e}`));
}
