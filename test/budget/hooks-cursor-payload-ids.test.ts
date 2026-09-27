/**
 * Budget auditor (brief 19), v4/hooks. Cursor's documented hook input
 * (https://cursor.com/docs/agent/hooks, checked 2026-09-27) gives every event `conversation_id`
 * and `generation_id`; only sessionStart and sessionEnd add `session_id`. beforeSubmitPrompt and
 * stop carry `conversation_id` alone.
 *
 * before-submit-prompt.js keys its once-per-session marker on normalizeStdin's sessionId, which reads
 * only `sessionId`/`session_id`. On the real payload that is '', no marker file can be named, and
 * every prompt runs a full recall round. Each GET /recall synthesizes by default (one scout call,
 * about 47 neurons at topK 5), so 150 prompts a day is about 7,000 of the 10,000 free neurons.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

function countFetches() {
  const calls: string[] = [];
  const real = global.fetch;
  global.fetch = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const body = path === "/recall" ? { ok: true, results: [{ id: "m1", content: "a stored note", score: 0.9 }], insight: "" } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { global.fetch = real; } };
}

/** The documented beforeSubmitPrompt input: common fields plus `prompt`, no session_id. */
const promptPayload = (dir: string) => ({
  conversation_id: "c0ffee-conv-1", generation_id: "gen-1", hook_event_name: "beforeSubmitPrompt",
  workspace_roots: [dir], transcript_path: null, prompt: "what did we decide about the cache",
});

describe("Cursor hooks on the documented payload make one recall round per conversation", () => {
  it("25 prompts in one conversation cost one recall round, not 25", async () => {
    const cursor = require("../../integrations/cursor-hooks/before-submit-prompt.js");
    const dir = mkdtempSync(join(tmpdir(), "sb-cursor-ids-"));
    const env = { SECOND_BRAIN_URL: "https://w.example", SECOND_BRAIN_TOKEN: "t" };
    const f = countFetches();
    try {
      for (let i = 0; i < 25; i++) await cursor.runBeforeSubmitPrompt(promptPayload(dir), { env, cacheDir: dir });
    } finally { f.restore(); }
    expect(f.calls.filter(p => p === "/recall").length).toBeLessThanOrEqual(2);
  });
});
