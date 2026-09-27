#!/usr/bin/env node
'use strict';
// The actual SessionEnd work for Codex CLI, spawned detached by
// session-end.js specifically so it can take longer than that file's 1-3s
// budget: read the transcript, parse it, decide whether there is enough
// conversation to keep, and POST /capture.
//
// The transcript parser below is written fresh for Codex rather than reusing
// claude-code-hooks' - Codex's own "rollout" JSONL format is not pinned down
// in the vendor docs the 2026-09-26 hooks survey worked from, and it is
// described there as unstable. This tries several plausible record shapes and
// quietly skips anything else; a malformed line or an unrecognized shape must
// never crash the worker. See README.md's "Unverified" section.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  performCapture, parseProjectLabel, projectSlug, gitRemoteUrl, resolveWorkspace, fail,
  resolveTranscriptPath,
} = require('../agent-hooks-core/core');

const NAMESPACE = 'codex';
const PER_CLIENT_ENV_VAR = 'SECOND_BRAIN_HOOK_CAPTURE_CODEX';
// Not on Codex's 1-3s SessionEnd clock: this process was spawned separately
// specifically so it can wait on an embedding and often a model call.
const CAPTURE_TIMEOUT_MS = 20000;
const WANT_USER_TURNS = 3;

/** A record's human text, from whichever plausible shape it turns out to be. */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c.text === 'string') return c.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * One parsed JSON record → a { role, text } turn, or null when it is not a
 * human message. Tries, in order:
 *   - `{ type: 'response_item', payload: { type: 'message', role, content } }`
 *     - the shape Codex's own "rollout" session files are believed to use
 *     (an OpenAI-Responses-API-shaped item log).
 *   - `{ type: 'event_msg', payload: { type: 'user_message'|'agent_message', message } }`
 *     - Codex's own higher-level event stream, if that is what transcript_path
 *     actually points at instead.
 *   - a flat `{ role: 'user'|'assistant', content|text|message }` - a fallback
 *     in case neither of the above holds up against a real session.
 * Every branch is UNVERIFIED against a real Codex CLI transcript.
 */
function turnFromRecord(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let role;
  let content;
  if (obj.type === 'response_item' && obj.payload && obj.payload.type === 'message') {
    role = obj.payload.role;
    content = obj.payload.content;
  } else if (obj.type === 'event_msg' && obj.payload && typeof obj.payload === 'object') {
    if (obj.payload.type === 'user_message') { role = 'user'; content = obj.payload.message ?? obj.payload.text; }
    else if (obj.payload.type === 'agent_message') { role = 'assistant'; content = obj.payload.message ?? obj.payload.text; }
    else return null;
  } else if (obj.role === 'user' || obj.role === 'assistant') {
    role = obj.role;
    content = obj.content ?? obj.text ?? obj.message;
  } else {
    return null;
  }
  if (role !== 'user' && role !== 'assistant') return null;
  const text = extractText(content).trim();
  if (!text) return null;
  return { role, text };
}

/**
 * Every line parsed independently, in file order (oldest first - Codex's
 * rollout files are append-only like every other adapter's transcript). One
 * malformed JSON line, or one that parses but does not match a known shape,
 * is skipped; it never aborts the read.
 */
function parseTranscript(raw) {
  const turns = [];
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const t = turnFromRecord(obj);
    if (t) turns.push(t);
  }
  return turns;
}

/** The last `want` user turns, oldest first - the plain-string shape performCapture's userTurns wants. */
function extractUserTurns(turns, want = WANT_USER_TURNS) {
  const users = turns.filter((t) => t.role === 'user').map((t) => t.text);
  return users.slice(-want);
}

/**
 * Where Codex keeps session transcripts: `$CODEX_HOME/sessions` (CODEX_HOME
 * defaults to ~/.codex), laid out as `sessions/YYYY/MM/DD/rollout-*.jsonl`
 * on a real install. Only a transcript that resolves inside it is read.
 */
function codexSessionsDir(env = process.env) {
  const home = (env.CODEX_HOME || '').trim() || path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

function readTranscript(transcriptPath) {
  try { return fs.readFileSync(transcriptPath, 'utf8'); } catch { return ''; }
}

/**
 * The testable main flow: parse the transcript this payload points at, build
 * the meta performCapture / buildSessionCaptureBody need, and hand off.
 * `overrides` is forwarded straight into performCapture so a test can supply
 * env, configPath or cacheDir without touching the real filesystem or network.
 */
async function run(payload, { transcriptRoot, ...overrides } = {}) {
  const { transcriptPath, cwd, sessionId } = payload || {};
  // Reviews showed a worker reading any readable transcript_path, including
  // one reached through `..` or a symlink. Only a path that resolves inside
  // Codex's own sessions directory is read. `transcriptRoot` is set only by
  // check.js and tests.
  const real = resolveTranscriptPath(transcriptPath, transcriptRoot ?? codexSessionsDir(overrides.env ?? process.env));
  if (!real) return { sent: false, reason: 'untrusted-transcript-path' };
  const turns = parseTranscript(readTranscript(real));
  const userTurns = extractUserTurns(turns);

  const remote = cwd ? gitRemoteUrl(cwd) : null;
  const projectName = parseProjectLabel(remote, cwd);
  const meta = {
    hostLabel: 'Codex',
    project: projectSlug(projectName),
    projectName,
    timestamp: new Date().toISOString(),
    workspace: resolveWorkspace(overrides.env ?? process.env),
    source: 'codex-session',
  };

  return performCapture({
    userTurns,
    meta,
    namespace: NAMESPACE,
    sessionId,
    perClientEnvVar: PER_CLIENT_ENV_VAR,
    captureTimeoutMs: CAPTURE_TIMEOUT_MS,
    ...overrides,
  });
}

async function main() {
  let payload;
  try { payload = JSON.parse(process.argv[2] ?? '{}'); } catch { payload = {}; }
  await run(payload);
}

module.exports = {
  NAMESPACE, PER_CLIENT_ENV_VAR, codexSessionsDir,
  extractText, turnFromRecord, parseTranscript, extractUserTurns, run, main,
};

if (require.main === module) {
  main().catch((e) => fail(`session capture failed: ${e?.message ?? e}`));
}
