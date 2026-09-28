import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanTemp } from '../helpers/tmp';

const core = require('../../integrations/agent-hooks-core/core.js');
const codex = require('../../integrations/codex-cli-hooks/capture-worker.js');
const claude = require('../../integrations/claude-code-hooks/session-end.js');
const credentials = { SECOND_BRAIN_URL: 'http://127.0.0.1:9', SECOND_BRAIN_TOKEN: 'local-test-token' };

afterEach(() => { vi.unstubAllGlobals(); cleanTemp(); });

describe('privacy filter adversarial review', () => {
  it('does not retain an unwrapped AGENTS.md body appended after a Codex user request', () => {
    const injected = 'Please fix the retry logic.\n\n# AGENTS.md instructions for /home/dev/private\nThe unpublished roadmap is PROJECT_ROADMAP_SENTINEL.';
    const turn = codex.turnFromRecord({ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: injected }],
    } });
    // Director's ruling: a block holding an instruction-file header anywhere is dropped whole.
    expect(turn).toBeNull();
    expect(JSON.stringify(turn)).not.toContain('PROJECT_ROADMAP_SENTINEL');
  });

  it('does not retain an unknown tool wrapper appended after typed text', () => {
    const injected = 'Please fix the retry logic.\n<tool_context>PRIVATE_TOOL_OUTPUT_SENTINEL</tool_context>';
    // Director's ruling: a block holding any wrapper-like tag anywhere is dropped whole.
    expect(core.stripInjectedContext(injected)).toBe('');
    expect(core.stripInjectedContext(injected)).not.toContain('PRIVATE_TOOL_OUTPUT_SENTINEL');
  });

  it('redacts a quoted password with spaces in both capture implementations', () => {
    const prompt = 'The staging DB_PASSWORD="correct horse battery staple" needs rotation.';
    for (const redact of [core.redactSecrets, (s: string) => claude.redactSecrets(s, 'local-test-token')]) {
      expect(redact(prompt)).not.toContain('correct horse battery staple');
    }
  });

  // ACCEPTED as the safe side (director's ruling): a typed request containing
  // markup cannot be told apart from an injected wrapper, so it is dropped.
  it('drops a real user request that contains HTML markup (accepted safe side)', () => {
    const typed = '<button>Save</button> should have an accessible name and a blue background.';
    const turn = codex.turnFromRecord({ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: typed }],
    } });
    expect(turn).toBeNull();
  });

  it('does not upload one kept capture twice when two session starts retry together', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'sb-spool-concurrent-'));
    core.spoolCapture('cursor', { content: 'one capture', source: 'cursor-session', workspace: 'personal' }, cache);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(String(init.body));
      started();
      await gate;
      return new Response('{}', { status: 200 });
    }));
    const first = core.flushCaptureSpool({ env: credentials, namespace: 'cursor', cacheDir: cache });
    await entered;
    const second = core.flushCaptureSpool({ env: credentials, namespace: 'cursor', cacheDir: cache });
    release();
    await Promise.all([first, second]);
    expect(sent).toHaveLength(1);
  });
});
