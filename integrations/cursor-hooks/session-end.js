#!/usr/bin/env node
'use strict';
// Session-end capture for the Cursor editor.
//
// Per Cursor's docs (https://prod.cursor.com/docs/hooks), `transcript_path`
// is a common field ("null if transcripts disabled") that `sessionEnd` does
// NOT carry, while `stop` does, and `stop` fires after every agent turn. So
// this one script runs for both, told apart by the `--event=` flag the
// installer passes (or the payload's own `hook_event_name`):
//   - stop:       records where this conversation's transcript is, locally
//                 (no request), so nothing is uploaded per turn;
//   - sessionEnd: captures once, from that recorded path.
// Either way the path is only used if it resolves, symlinks and `..`
// included, inside Cursor's own transcript directory. Cursor's docs do not
// name that directory; a real install keeps them in
// ~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl, so the
// allowed root is ~/.cursor/projects.
//
// The project comes from `workspace_roots`, never the hook's own working
// directory (Cursor runs user hooks from ~/.cursor).
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const {
  readStdinJson, performCapture, gitRemoteUrl, parseProjectLabel, projectSlug, resolveWorkspace, fail,
  resolveTranscriptPath, writeSessionCache, readSessionCache,
} = require('../agent-hooks-core/core');
const { normalizeStdin } = require('./session-start');

const NAMESPACE = 'cursor';
const PER_CLIENT_ENV_VAR = 'SECOND_BRAIN_HOOK_CAPTURE_CURSOR';
// Where `stop` records the transcript path for `sessionEnd` to read.
const TRANSCRIPT_KEY = 'cursor-transcript';
// A session worth capturing only needs its last few user turns (performCapture
// keeps 3), so a generous tail is plenty; this bounds memory on an unexpectedly
// huge or corrupt transcript instead of reading the whole thing unconditionally.
const READ_CEILING_BYTES = 2 * 1024 * 1024;

function cursorTranscriptsDir() {
  return path.join(os.homedir(), '.cursor', 'projects');
}

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
 * What the person typed. Real Cursor transcripts wrap it as
 * `<timestamp>...</timestamp><user_query>...</user_query>`; the query is
 * kept and the wrapper dropped. Text without that wrapper is kept as-is.
 */
function userQueryText(text) {
  const parts = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((m) => m[1].trim()).filter(Boolean);
  return parts.length ? parts.join('\n') : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '').trim();
}

/**
 * One JSONL line to a turn, or null when it is not a recognisable human turn.
 * The real record shape is `{ role, message: { content: [{ type: 'text',
 * text }, ...] } }`; flatter shapes are still accepted. Never throws: a
 * malformed or truncated line is skipped.
 */
function turnFromLine(line) {
  if (!line || !line.trim()) return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const role = typeof obj.role === 'string' ? obj.role : typeof obj.type === 'string' ? obj.type : '';
  if (role !== 'user' && role !== 'assistant') return null;
  const raw = obj.message && typeof obj.message === 'object' && 'content' in obj.message
    ? obj.message.content
    : obj.content ?? obj.message ?? obj.text;
  let text = textFromContent(raw).trim();
  if (role === 'user') text = userQueryText(text);
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

/**
 * The testable flow. `event` is 'stop' or 'sessionEnd' (from the installer's
 * `--event=` flag, else the payload's `hook_event_name`). `transcriptRoot` is
 * set only by tests; `env`, `configPath` and `cacheDir` go to performCapture.
 */
async function runSessionEnd(payload, { event, transcriptRoot, ...overrides } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const { sessionId, cwd } = normalizeStdin(p);
  const kind = event || (typeof p.hook_event_name === 'string' ? p.hook_event_name : '');
  const root = transcriptRoot ?? cursorTranscriptsDir();
  const given = typeof p.transcript_path === 'string' ? p.transcript_path
    : typeof p.transcriptPath === 'string' ? p.transcriptPath : '';

  if (kind === 'stop') {
    const real = resolveTranscriptPath(given, root);
    if (real && sessionId) writeSessionCache(TRANSCRIPT_KEY, sessionId, real, overrides.cacheDir);
    return { sent: false, reason: 'remembered' };
  }

  const remembered = sessionId ? readSessionCache(TRANSCRIPT_KEY, sessionId, Date.now(), overrides.cacheDir) : null;
  const real = resolveTranscriptPath(given || remembered || '', root);
  if (!real) return { sent: false, reason: 'no-transcript' }; // transcripts off, or never recorded: not a failure

  const userTurns = readUserTurns(real);
  const projectName = parseProjectLabel(gitRemoteUrl(cwd), cwd);
  const meta = {
    hostLabel: 'Cursor',
    project: projectSlug(projectName),
    projectName,
    timestamp: new Date().toISOString(),
    workspace: resolveWorkspace(overrides.env ?? process.env),
    source: 'cursor-session',
  };
  return performCapture({ userTurns, meta, namespace: NAMESPACE, sessionId, perClientEnvVar: PER_CLIENT_ENV_VAR, ...overrides });
}

async function main() {
  const flag = process.argv.find((a) => a.startsWith('--event='));
  const payload = await readStdinJson();
  await runSessionEnd(payload, { event: flag ? flag.slice('--event='.length) : undefined });
}

module.exports = {
  NAMESPACE, TRANSCRIPT_KEY, cursorTranscriptsDir,
  textFromContent, userQueryText, turnFromLine, readTail, readUserTurns, runSessionEnd, main,
};

if (require.main === module) {
  main().catch((e) => fail(`session capture failed: ${e?.message ?? e}`));
}
