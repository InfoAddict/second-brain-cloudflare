import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanTemp } from '../helpers/tmp';

const root = resolve(import.meta.dirname, '../..');
const core = require('../../integrations/agent-hooks-core/core.js');
const codexWorker = require('../../integrations/codex-cli-hooks/capture-worker.js');
const cursorStart = require('../../integrations/cursor-hooks/session-start.js');
const creds = { SECOND_BRAIN_URL: 'http://127.0.0.1:9', SECOND_BRAIN_TOKEN: 'local-test-token' };
const body = (label: string) => ({ content: label, source: 'cursor-session', workspace: 'personal' });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); cleanTemp(); });

describe('spool, session identity, and transcript validation', () => {
  it('accepts conversation_id as the shared Cursor identity', () => {
    expect(cursorStart.normalizeStdin({ conversation_id: 'conversation-123' }).sessionId).toBe('conversation-123');
  });

  // Superseded by the director's simplification (T-0089.8): the fallback that
  // put recall in a blocked-only user_message is removed, not reshaped.
  it('does not put recall in a blocked-only message while allowing the Cursor prompt', () => {
    expect(existsSync(join(root, 'integrations/cursor-hooks/before-submit-prompt.js'))).toBe(false);
  });

  it('does not follow a spool symlink and overwrite an unrelated file', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-spool-link-'));
    const cache = join(scratch, 'cache');
    mkdirSync(cache);
    const victim = join(scratch, 'unrelated.json');
    writeFileSync(victim, 'keep this file');
    symlinkSync(victim, join(cache, 'capture-spool-cursor.json'));
    core.spoolCapture('cursor', body('queued'), cache);
    expect(readFileSync(victim, 'utf8')).toBe('keep this file');
    expect(statSync(join(cache, 'capture-spool-cursor.json')).isFile()).toBe(true);
  });

  it('does not claim a failed upload was kept when spool persistence fails', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-spool-write-fail-'));
    mkdirSync(join(scratch, 'capture-spool-cursor.json'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/capture')) throw new Error('offline');
      return new Response(JSON.stringify({ version: '4.0.0' }), { status: 200 });
    }));
    const result = await core.performCapture({ env: creds, namespace: 'cursor', sessionId: 's1',
      userTurns: [`Important request ${'x'.repeat(220)}`], cacheDir: scratch,
      meta: { hostLabel: 'Cursor', project: 'app', source: 'cursor-session', workspace: 'personal' },
    });
    expect(result.reason === 'spooled' && core.readCaptureSpool('cursor', scratch).length === 0).toBe(false);
  });

  it('keeps a capture appended while an earlier spool flush is in flight', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-spool-race-'));
    core.spoolCapture('cursor', body('earlier'), scratch);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      started();
      await gate;
      return new Response('{}', { status: 200 });
    }));
    const flushing = core.flushCaptureSpool({ env: creds, namespace: 'cursor', cacheDir: scratch });
    await entered;
    core.spoolCapture('cursor', body('new capture'), scratch);
    release();
    await flushing;
    expect(core.readCaptureSpool('cursor', scratch).map((entry: any) => entry.body.content)).toContain('new capture');
  });

  it('commits each successful retry before trying the next entry', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-spool-progress-'));
    core.spoolCapture('cursor', body('first'), scratch);
    core.spoolCapture('cursor', body('second'), scratch);
    let persistedAtSecondRequest: string[] = [];
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 2) persistedAtSecondRequest = core.readCaptureSpool('cursor', scratch).map((entry: any) => entry.body.content);
      return new Response('{}', { status: 200 });
    }));
    await core.flushCaptureSpool({ env: creds, namespace: 'cursor', cacheDir: scratch });
    expect(persistedAtSecondRequest).toEqual(['second']);
  });

  it('backs off after one server outage instead of retrying all twenty entries', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-spool-storm-'));
    for (let i = 0; i < 20; i++) core.spoolCapture('cursor', body(`queued-${i}`), scratch);
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; return new Response('{}', { status: 500 }); }));
    await core.flushCaptureSpool({ env: creds, namespace: 'cursor', cacheDir: scratch });
    expect(calls).toBeLessThanOrEqual(1);
  });

  it('shares one Cursor deadline between spool retry and recall', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-spool-deadline-'));
    const project = join(scratch, 'app');
    mkdirSync(project);
    core.spoolCapture('cursor', body('queued'), scratch);
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (String(url).endsWith('/capture')) return new Promise((resolve) => setTimeout(() => resolve(new Response('{}', { status: 200 })), 150));
      if (String(url).includes('/brief')) return Promise.resolve(new Response('{}', { status: 200 }));
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }));
    const began = Date.now();
    await core.performRecall({ env: creds, namespace: 'cursor', cwd: project, sessionId: 'new-session', capMs: 200, cacheDir: scratch });
    expect(Date.now() - began).toBeLessThan(330);
  });

  it('rejects a same-named transcript reached with dot-dot or a symlink', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-transcript-bypass-'));
    const own = join(scratch, 'own');
    const other = join(scratch, 'other');
    mkdirSync(own); mkdirSync(other);
    const outside = join(other, 'own-session.jsonl');
    writeFileSync(outside, [1, 2, 3].map((n) => JSON.stringify({ role: 'user', content: `Private other project ${n} ${'x'.repeat(90)}` })).join('\n'));
    const link = join(own, 'own-session.jsonl');
    symlinkSync(outside, link);
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/capture')) posts++;
      return new Response(JSON.stringify(String(url).endsWith('/health') ? { version: '4.0.0' } : { ok: true }), { status: 200 });
    }));
    for (const transcriptPath of [join(own, '..', 'other', 'own-session.jsonl'), link]) {
      await codexWorker.run({ cwd: own, sessionId: 'own-session', transcriptPath }, { env: creds, cacheDir: join(scratch, 'cache') });
    }
    expect(posts).toBe(0);
  });

  it('tags Cursor capture with workspace_roots rather than the user hooks directory', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-cursor-end-project-'));
    const project = join(scratch, 'active-project');
    const hooksDir = join(scratch, '.cursor');
    mkdirSync(project); mkdirSync(hooksDir);
    // Adjusted for rule C: a transcript is only read from inside Cursor's own
    // transcript directory (~/.cursor/projects), so HOME points at scratch.
    const transcriptDir = join(hooksDir, 'projects', 'active-project', 'agent-transcripts', 'conversation-123');
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, 'conversation-123.jsonl');
    writeFileSync(transcriptPath, [1, 2, 3].map((n) => JSON.stringify({ role: 'user', content: `Project request ${n} ${'x'.repeat(90)}` })).join('\n'));
    const script = join(root, 'integrations/cursor-hooks/session-end.js');
    const preload = `global.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith('/health') ? {version:'4.0.0'} : {ok:true}), {status:200}); require(${JSON.stringify(script)}).main();`;
    const stdout = execFileSync(process.execPath, ['-e', preload], {
      cwd: hooksDir,
      input: JSON.stringify({ conversation_id: 'conversation-123', workspace_roots: [project], transcript_path: transcriptPath }),
      env: { ...process.env, ...creds, HOME: scratch, SECOND_BRAIN_DRY_RUN: '1', XDG_CACHE_HOME: join(scratch, 'cache') },
      encoding: 'utf8',
    });
    expect(JSON.parse(stdout).project).toBe('active-project');
  });
});
