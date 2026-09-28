import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanTemp } from '../helpers/tmp';

const root = resolve(import.meta.dirname, '../..');
const core = require('../../integrations/agent-hooks-core/core.js');
const cursorStart = require('../../integrations/cursor-hooks/session-start.js');
const codexWorker = require('../../integrations/codex-cli-hooks/capture-worker.js');
const claudeCurrent = require('../../integrations/claude-code-hooks/session-start.js');
const claudeGolden = require('../../integrations/claude-code-hooks/fixtures/pre-shared-core.session-start.js');

afterEach(() => { vi.restoreAllMocks(); cleanTemp(); });

function install(client: string, home: string) {
  execFileSync('bash', [join(root, 'integrations', client, 'install.sh'), 'http://127.0.0.1:9', 'local-test-token'], {
    env: { ...process.env, HOME: home },
    stdio: 'pipe',
  });
}

describe('hook contract and trust boundary repros', () => {
  it('Codex SessionEnd timeout is the documented maximum of 3 seconds', () => {
    const home = mkdtempSync(join(tmpdir(), 'sb-codex-review-'));
    install('codex-cli-hooks', home);
    const hooks = JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8'));
    expect(hooks.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
  });

  it('Copilot Local installer writes the documented hooks map and flat command', () => {
    const home = mkdtempSync(join(tmpdir(), 'sb-copilot-review-'));
    install('vscode-copilot-hooks', home);
    const hooks = JSON.parse(readFileSync(join(home, '.copilot/hooks/second-brain.json'), 'utf8'));
    expect(hooks.hooks.SessionStart[0].type).toBe('command');
    expect(hooks.hooks.SessionStart[0].command).toContain('session-start.js');
  });

  it('Gemini installer does not give the client more than the required 3 seconds', () => {
    const home = mkdtempSync(join(tmpdir(), 'sb-gemini-install-review-'));
    install('gemini-cli-hooks', home);
    const settings = JSON.parse(readFileSync(join(home, '.gemini/settings.json'), 'utf8'));
    expect(settings.hooks.SessionStart[0].hooks[0].timeout).toBeLessThanOrEqual(3000);
  });

  // Superseded by the director's simplification (T-0089.8): beforeSubmitPrompt's
  // user_message never reaches the model, so the fallback was removed rather
  // than reshaped. This now proves it is gone and no longer installed.
  it('Cursor has no beforeSubmitPrompt fallback at all', () => {
    const home = mkdtempSync(join(tmpdir(), 'sb-cursor-review-'));
    install('cursor-hooks', home);
    const hooks = JSON.parse(readFileSync(join(home, '.cursor/hooks.json'), 'utf8'));
    expect(hooks.hooks.beforeSubmitPrompt).toBeUndefined();
    expect(existsSync(join(root, 'integrations/cursor-hooks/before-submit-prompt.js'))).toBe(false);
  });

  it('Cursor resolves project from the documented workspace_roots input', () => {
    const project = '/tmp/current-cursor-project';
    expect(cursorStart.normalizeStdin({ session_id: 's1', workspace_roots: [project] }).cwd).toBe(project);
  });

  it('Gemini recall shares one cap across project and fallback requests', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-gemini-review-'));
    const project = join(scratch, 'app');
    mkdirSync(project);
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (String(url).includes('/brief')) return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      if (String(url).includes('project=')) return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })), 150));
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }));
    const began = Date.now();
    await core.performRecall({ cwd: project, sessionId: 's1', namespace: 'gemini-review', capMs: 200,
      env: { SECOND_BRAIN_URL: 'http://127.0.0.1:9', SECOND_BRAIN_TOKEN: 'local-test-token' }, cacheDir: join(scratch, 'cache') });
    // 280ms cut it too close against real overhead (git subprocess spawn, JS
    // scheduling) on a loaded machine, flaking on an already-fixed
    // implementation about 1 run in 3. 330ms still fails unambiguously
    // against the pre-fix behavior this measured at ~376ms (a fresh cap per
    // recall step) while giving the fixed ~200-290ms path real margin.
    expect(Date.now() - began).toBeLessThan(330);
  });

  it('recall cache containing private memories is owner-readable only', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-cache-review-'));
    const before = process.umask(0o022);
    try { core.writeSessionCache('review', 's1', 'private recalled memory', scratch); }
    finally { process.umask(before); }
    const file = core.sessionCacheFile('review', 's1', scratch);
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('Codex refuses a transcript_path from an unrelated project', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-path-review-'));
    const own = join(scratch, 'own-project');
    const other = join(scratch, 'other-project');
    mkdirSync(own); mkdirSync(other);
    const transcriptPath = join(other, 'other-session.jsonl');
    writeFileSync(transcriptPath, [1, 2, 3].map((n) => JSON.stringify({ role: 'user', content: `Other project's private transcript ${n}: ${'x'.repeat(90)}` })).join('\n'));
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (String(url).endsWith('/capture')) posts.push(String(init.body));
      return Promise.resolve(new Response(JSON.stringify(String(url).endsWith('/health') ? { version: '4.0.0' } : { ok: true }), { status: 200 }));
    }));
    await codexWorker.run({ cwd: own, sessionId: 'own-session', transcriptPath }, {
      env: { SECOND_BRAIN_URL: 'http://127.0.0.1:9', SECOND_BRAIN_TOKEN: 'local-test-token' },
      cacheDir: join(scratch, 'cache'),
    });
    expect(posts).toHaveLength(0);
  });

  it('simultaneous end events do not upload the same session twice', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-double-review-'));
    let captures = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/capture')) {
        captures++;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return new Response(JSON.stringify(String(url).endsWith('/health') ? { version: '4.0.0' } : { ok: true }), { status: 200 });
    }));
    const args = {
      env: { SECOND_BRAIN_URL: 'http://127.0.0.1:9', SECOND_BRAIN_TOKEN: 'local-test-token' },
      userTurns: [`Important user request ${'x'.repeat(220)}`],
      meta: { hostLabel: 'Cursor', project: 'app', source: 'cursor-session', workspace: 'personal' },
      namespace: 'cursor', sessionId: 'same-session', cacheDir: join(scratch, 'cache'),
    };
    await Promise.all([core.performCapture(args), core.performCapture(args)]);
    expect(captures).toBe(1);
  });

  it('Cursor stop does not suppress a later sessionEnd with the final turn', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-partial-review-'));
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/capture')) bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(String(url).endsWith('/health') ? { version: '4.0.0' } : { ok: true }), { status: 200 });
    }));
    const args = {
      env: { SECOND_BRAIN_URL: 'http://127.0.0.1:9', SECOND_BRAIN_TOKEN: 'local-test-token' },
      meta: { hostLabel: 'Cursor', project: 'app', source: 'cursor-session', workspace: 'personal' },
      namespace: 'cursor', sessionId: 'same-session', cacheDir: join(scratch, 'cache'),
    };
    await core.performCapture({ ...args, userTurns: [`First turn ${'x'.repeat(220)}`] });
    await core.performCapture({ ...args, userTurns: [`First turn ${'x'.repeat(220)}`, `Final turn ${'y'.repeat(100)}`] });
    expect(bodies.at(-1).content).toContain('Final turn');
  });

  it('stdin JSON longer than 64 KiB is parsed after the complete message arrives', async () => {
    const child = spawn(process.execPath, ['-e',
      `require(${JSON.stringify(join(root, 'integrations/agent-hooks-core/core.js'))}).readStdinJson().then(v => { console.log(JSON.stringify(v)); });`],
      { stdio: 'pipe' });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    const finished = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    child.stdin.write(`{"prompt":"${'x'.repeat(70000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.stdin.end('","session_id":"s1"}');
    expect(await finished).toBe(0);
    expect(JSON.parse(stdout).session_id).toBe('s1');
  });

  it('an open stdin pipe cannot keep a hook alive after its read deadline', async () => {
    const child = spawn(process.execPath, ['-e',
      `require(${JSON.stringify(join(root, 'integrations/agent-hooks-core/core.js'))}).readStdinJson().then(() => console.log('read done'));`],
      { stdio: 'pipe' });
    const closed = new Promise<boolean>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', () => resolve(true));
    });
    const exited = await Promise.race([closed, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1900))]);
    if (!exited) { child.kill('SIGTERM'); await closed; }
    expect(exited).toBe(true);
  }, 4000);

  it('Claude Code preserves its pre-refactor cache path for compacted sessions', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-claude-cache-review-'));
    expect(claudeCurrent.sessionCacheFile('s1', scratch)).toBe(claudeGolden.sessionCacheFile('s1', scratch));
  });
});
