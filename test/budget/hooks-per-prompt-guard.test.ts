/**
 * Budget guard for v4/hooks: no hook may cost a request per prompt or per turn.
 *
 * The original guard pinned before-submit-prompt.js's once-per-session marker (and a silent
 * failure mode: an unwritable cache dir meant the marker never persisted, so every prompt ran a
 * recall). UPDATED (T-0089.8 simplification): the beforeSubmitPrompt fallback is removed, so no
 * Cursor hook runs per prompt. The per-turn event that remains is `stop`, which fires after every
 * agent turn; it must make no request at all, even when the cache dir cannot be written.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);
const tmp = () => mkdtempSync(join(tmpdir(), "sb-hooks-prompt-guard-"));
const root = resolve(import.meta.dirname, "../..");

describe("no hook runs a request per prompt or per turn", () => {
  it("the Cursor installer registers no per-prompt event", () => {
    const home = tmp();
    execFileSync("bash", [join(root, "integrations/cursor-hooks/install.sh"), "https://w.example", "t"], {
      env: { PATH: process.env.PATH!, HOME: home } as unknown as NodeJS.ProcessEnv, stdio: "pipe",
    });
    const events = Object.keys(JSON.parse(readFileSync(join(home, ".cursor/hooks.json"), "utf8")).hooks);
    expect(events.sort()).toEqual(["sessionEnd", "sessionStart", "stop"]);
  });

  it("stop makes no request, even when its cache dir is unwritable", async () => {
    const end = require("../../integrations/cursor-hooks/session-end.js");
    const dir = tmp();
    const projects = join(dir, "projects");
    const tdir = join(projects, "app", "agent-transcripts", "conv-1");
    mkdirSync(tdir, { recursive: true });
    const transcript = join(tdir, "conv-1.jsonl");
    writeFileSync(transcript, JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "x".repeat(300) }] } }));
    const cache = join(dir, "cache");
    mkdirSync(cache);
    chmodSync(cache, 0o500);
    const calls: string[] = [];
    const real = global.fetch;
    global.fetch = (async (url: string) => { calls.push(String(url)); return new Response("{}", { status: 200 }); }) as typeof fetch;
    try {
      for (let i = 0; i < 25; i++) {
        await end.runSessionEnd({ conversation_id: "conv-1", workspace_roots: [dir], transcript_path: transcript },
          { event: "stop", transcriptRoot: projects, env: { SECOND_BRAIN_URL: "https://w.example", SECOND_BRAIN_TOKEN: "t" }, cacheDir: cache });
      }
    } catch { /* an unwritable cache may throw inside the hook; the point is it never reaches the network */ } finally {
      global.fetch = real;
      chmodSync(cache, 0o700);
    }
    expect(calls).toEqual([]);
  });
});
