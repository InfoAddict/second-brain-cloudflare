/**
 * Budget auditor (brief 19), v4/hooks. Cursor's documented hook input
 * (https://cursor.com/docs/agent/hooks, checked 2026-09-27) gives every event `conversation_id`
 * and `generation_id`; only sessionStart and sessionEnd add `session_id`.
 *
 * The original finding: before-submit-prompt.js keyed its once-per-session marker on
 * `session_id`, which beforeSubmitPrompt never carries, so 25 prompts ran 25 recalls.
 *
 * UPDATED (T-0089.8 simplification): the beforeSubmitPrompt fallback is removed, because its
 * `user_message` only reaches the user when a prompt is blocked, never the model. No Cursor hook
 * runs per prompt any more. This file now guards the per-conversation costs that remain:
 * one recall per conversation (sessionStart) and, although `stop` fires after every agent turn,
 * zero requests from `stop` and exactly one capture from `sessionEnd`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    const body = path === "/recall" ? { ok: true, results: [{ id: "m1", content: "a stored note", score: 0.9 }] }
      : path === "/health" ? { ok: true, version: "4.0.0" } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { global.fetch = real; } };
}

describe("Cursor hooks cost one recall and one capture per conversation", () => {
  it("sessionStart on the documented payload makes one recall round", async () => {
    const start = require("../../integrations/cursor-hooks/session-start.js");
    const dir = mkdtempSync(join(tmpdir(), "sb-cursor-ids-"));
    const env = { SECOND_BRAIN_URL: "https://w.example", SECOND_BRAIN_TOKEN: "t" };
    const f = countFetches();
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await start.runSessionStart({ conversation_id: "c0ffee-conv-1", session_id: "s-1", workspace_roots: [dir] }, { env, cacheDir: dir });
    } finally { f.restore(); process.stdout.write = write; }
    expect(f.calls.filter(p => p === "/recall").length).toBeLessThanOrEqual(2);
  });

  it("25 stop events send nothing, and the sessionEnd after them captures exactly once", async () => {
    const end = require("../../integrations/cursor-hooks/session-end.js");
    const dir = mkdtempSync(join(tmpdir(), "sb-cursor-stop-"));
    const root = join(dir, "projects");
    const transcriptDir = join(root, "app", "agent-transcripts", "c0ffee-conv-1");
    mkdirSync(transcriptDir, { recursive: true });
    const transcript = join(transcriptDir, "c0ffee-conv-1.jsonl");
    const env = { SECOND_BRAIN_URL: "https://w.example", SECOND_BRAIN_TOKEN: "t" };
    const f = countFetches();
    try {
      for (let i = 0; i < 25; i++) {
        writeFileSync(transcript, Array.from({ length: i + 3 }, (_, n) => JSON.stringify({ role: "user", message: { content: [{ type: "text", text: `<user_query>turn ${n} ${"x".repeat(90)}</user_query>` }] } })).join("\n"));
        await end.runSessionEnd(
          { conversation_id: "c0ffee-conv-1", hook_event_name: "stop", workspace_roots: [dir], transcript_path: transcript },
          { event: "stop", transcriptRoot: root, env, cacheDir: dir },
        );
      }
      expect(f.calls).toEqual([]);
      await end.runSessionEnd(
        { conversation_id: "c0ffee-conv-1", hook_event_name: "sessionEnd", workspace_roots: [dir] },
        { event: "sessionEnd", transcriptRoot: root, env, cacheDir: dir },
      );
    } finally { f.restore(); }
    expect(f.calls.filter(p => p === "/capture").length).toBe(1);
  });
});
