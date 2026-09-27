/**
 * The Cursor hooks, run as real processes with the stdin shape this adapter
 * assumes Cursor sends, against a loopback HTTP stub (127.0.0.1:0, no real
 * network). Like the vscode-copilot-hooks contract test, this proves the
 * hooks' own request/response handling and dedup logic against the stub, not
 * that the URLs they build are ones a real Worker accepts (agent-hooks-core's
 * own unit tests and the Claude Code contract test already cover that against
 * the shared core).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterAll(cleanTemp);

const HOOKS = resolve(import.meta.dirname, "../../integrations/cursor-hooks");
const FIXTURE = join(HOOKS, "fixtures/sample-transcript.jsonl");

interface Captured { method: string; url: string; body: string }
interface StubBehaviour {
  recallStatus?: number; recallResults?: unknown[]; briefStatus?: number; recallDelayMs?: number;
  captureStatus?: number; healthVersion?: string;
}

let server: Server;
let origin = "";
let captured: Captured[] = [];
let behaviour: StubBehaviour = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", body });
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const send = () => {
        if (req.url?.startsWith("/health")) return reply(200, { ok: true, version: behaviour.healthVersion ?? "3.0.0" });
        if (req.url?.startsWith("/recall")) {
          if (behaviour.recallStatus && behaviour.recallStatus >= 400) return reply(behaviour.recallStatus, { ok: false, code: "unauthorized" });
          return reply(200, { ok: true, results: behaviour.recallResults ?? [{ id: "m1", content: "a remembered thing", truncated: false }], insight: null });
        }
        if (req.url?.startsWith("/brief")) {
          if (behaviour.briefStatus) return reply(behaviour.briefStatus, { ok: false });
          return reply(200, { ok: true });
        }
        if (req.url === "/capture") {
          if (behaviour.captureStatus && behaviour.captureStatus >= 400) return reply(behaviour.captureStatus, { ok: false, code: "unauthorized" });
          return reply(200, { ok: true, id: "new-id" });
        }
        return reply(404, { ok: false });
      };
      const delay = req.url?.startsWith("/recall") ? behaviour.recallDelayMs : undefined;
      delay ? setTimeout(send, delay) : send();
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

let scratch: string;
let project: string;
let cacheDir: string;

beforeEach(() => {
  captured = [];
  behaviour = {};
  scratch = mkdtempSync(join(tmpdir(), "sb-cursor-hooks-"));
  project = join(scratch, "brain-app");
  cacheDir = join(scratch, "cache");
  mkdirSync(project);
});
afterEach(cleanTemp);

/** Spawn a hook exactly as Cursor would: payload on stdin, then EOF. Isolated HOME and cache. */
function runHook(script: string, payload: object, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn("node", [`${HOOKS}/${script}`], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: scratch, XDG_CACHE_HOME: cacheDir,
        SECOND_BRAIN_URL: origin, SECOND_BRAIN_TOKEN: "test-token",
        ...extraEnv,
      } as unknown as NodeJS.ProcessEnv, // wrangler's types make AUTH_TOKEN required; the hook must not inherit it
      stdio: "pipe",
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("error", fail);
    child.on("close", code => done({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const startPayload = (sessionId = "s1") => ({ sessionId, cwd: project });
const endPayload = (transcript_path: string, sessionId = "s1") => ({ sessionId, cwd: project, transcript_path });

describe("session-start.js", () => {
  it("emits the flat additional_context shape and marks delivery", async () => {
    const r = await runHook("session-start.js", startPayload());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed)).toEqual(["additional_context"]);
    expect(parsed.additional_context).toContain("[Second Brain] Context recalled");
    expect(parsed.additional_context).toContain("a remembered thing");
    expect(parsed.additional_context).not.toContain("Bearer");
    expect(parsed.additional_context).not.toContain("test-token");

    const recalls = captured.filter(c => c.url.startsWith("/recall?"));
    expect(recalls.length).toBeGreaterThanOrEqual(1);

    const markerFile = join(cacheDir, "second-brain", "session-cursor-delivered-s1.txt");
    expect(existsSync(markerFile)).toBe(true);
  });

  it("reports a rejected token: exit 1, [Second Brain] stderr, no stdout, no secrets", async () => {
    behaviour.recallStatus = 401;
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed: HTTP 401/);
    expect(r.stderr).not.toContain("test-token");
    expect(r.stderr).not.toContain("Bearer");
  });

  it("fails without hanging when the Worker is down", async () => {
    const started = Date.now();
    const r = await runHook("session-start.js", startPayload(), { SECOND_BRAIN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed:/);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 10000);

  it("still resolves within the 3s cap even when the stub delays recall", async () => {
    behaviour.recallDelayMs = 6000;
    const started = Date.now();
    const r = await runHook("session-start.js", startPayload());
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(6000); // well under the delay: the cap, not the stub, decides
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed: no reply within [0-3]\.\ds/);
  }, 10000);

  it("does nothing without credentials, and honours the opt-out", async () => {
    const r = await runHook("session-start.js", startPayload(), { SECOND_BRAIN_URL: "", SECOND_BRAIN_TOKEN: "" });
    expect(r.code).toBe(0); expect(r.stdout).toBe(""); expect(captured).toHaveLength(0);
    const r2 = await runHook("session-start.js", startPayload(), { SECOND_BRAIN_HOOK_RECALL: "0" });
    expect(r2.stdout).toBe("");
    expect(captured).toHaveLength(0);
  });
});

describe("before-submit-prompt.js", () => {
  it("after a successful session-start, emits nothing and makes no request at all", async () => {
    const first = await runHook("session-start.js", startPayload("s2"));
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("additional_context");

    captured = [];
    const second = await runHook("before-submit-prompt.js", startPayload("s2"));
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toBe("");
    expect(captured).toHaveLength(0);
  });

  it("without a prior session-start, delivers context itself and marks delivery; the next call in-session emits nothing", async () => {
    const first = await runHook("before-submit-prompt.js", startPayload("s3"));
    expect(first.code, first.stderr).toBe(0);
    // beforeSubmitPrompt's documented output shape is NOT sessionStart's: only
    // `continue` and `user_message` are recognized fields for this event
    // (https://prod.cursor.com/docs/hooks).
    const parsed = JSON.parse(first.stdout.trim());
    expect(Object.keys(parsed).sort()).toEqual(["continue", "user_message"]);
    expect(parsed.continue).toBe(true);
    expect(parsed.user_message).toContain("a remembered thing");
    const firstRecallCount = captured.filter(c => c.url.startsWith("/recall?")).length;
    expect(firstRecallCount).toBeGreaterThanOrEqual(1);

    captured = [];
    const second = await runHook("before-submit-prompt.js", startPayload("s3"));
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toBe("");
    expect(captured.filter(c => c.url.startsWith("/recall?"))).toHaveLength(0);
  });

  it("reports a rejected token like session-start does", async () => {
    behaviour.recallStatus = 401;
    const r = await runHook("before-submit-prompt.js", startPayload("s4"));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed: HTTP 401/);
  });

  it("fails without hanging when the Worker is down", async () => {
    const started = Date.now();
    const r = await runHook("before-submit-prompt.js", startPayload("s5"), { SECOND_BRAIN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed:/);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 10000);

  it("still resolves within the 3s cap when the stub delays", async () => {
    behaviour.recallDelayMs = 6000;
    const started = Date.now();
    const r = await runHook("before-submit-prompt.js", startPayload("s6"));
    expect(Date.now() - started).toBeLessThan(6000);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no reply within [0-3]\.\ds/);
  }, 10000);
});

describe("session-end.js", () => {
  it("reads transcript_path and makes one POST /capture with the exact header and body shape", async () => {
    const transcript = join(scratch, "cap-1.jsonl");
    copyFileSync(FIXTURE, transcript);
    const r = await runHook("session-end.js", endPayload(transcript, "cap-1"));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(""); // Cursor ignores this event's output; nothing but a DRY_RUN print goes to stdout

    const captures = captured.filter(c => c.url === "/capture");
    expect(captures).toHaveLength(1);
    const body = JSON.parse(captures[0].body);
    expect(body.source).toBe("cursor-session");
    expect(body.workspace).toBe("personal");
    expect(body.content).toMatch(/^Cursor session in brain-app, \d{4}-\d{2}-\d{2}/);
    expect(body.content).toContain("User: Let's wire the nightly digest");
    expect(body.content).toContain("User: Actually hold off on shipping");
    expect(body.content).not.toContain("sk-abcdef1234567890ABCDEF");
    expect(body.content).toContain("[redacted]");
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.tags).toEqual(["brain-app"]);
  });

  it("does not capture a transcript with no substantial human text", async () => {
    const transcript = join(scratch, "cap-2.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ role: "user", content: "hi" }),
      JSON.stringify({ role: "assistant", content: "hello" }),
    ].join("\n") + "\n");
    const r = await runHook("session-end.js", endPayload(transcript, "cap-2"));
    expect(r.code).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("no-ops (exit 0, no request at all) when transcript_path is absent", async () => {
    const r = await runHook("session-end.js", { sessionId: "cap-3", cwd: project });
    expect(r.code, r.stderr).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it("no-ops when transcript_path points at a file that does not exist", async () => {
    const r = await runHook("session-end.js", endPayload(join(scratch, "does-not-exist.jsonl"), "cap-4"));
    expect(r.code, r.stderr).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it("never captures the same session twice, even across two separate process runs", async () => {
    const transcript = join(scratch, "cap-5.jsonl");
    copyFileSync(FIXTURE, transcript);
    const first = await runHook("session-end.js", endPayload(transcript, "cap-5"));
    expect(first.code, first.stderr).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(1);

    captured = [];
    const second = await runHook("session-end.js", endPayload(transcript, "cap-5"));
    expect(second.code, second.stderr).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("reports a rejected token on capture: stderr line and exit 1", async () => {
    behaviour.captureStatus = 401;
    const transcript = join(scratch, "cap-6.jsonl");
    copyFileSync(FIXTURE, transcript);
    const r = await runHook("session-end.js", endPayload(transcript, "cap-6"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\[Second Brain\] session capture failed: HTTP 401/);
  });

  it("does not capture against a Worker older than 3.0, and says so once", async () => {
    behaviour.healthVersion = "2.4.0";
    const transcript = join(scratch, "cap-7.jsonl");
    copyFileSync(FIXTURE, transcript);
    const first = await runHook("session-end.js", endPayload(transcript, "cap-7"));
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("needs Worker 3.0+");
    const transcript2 = join(scratch, "cap-8.jsonl");
    copyFileSync(FIXTURE, transcript2);
    const second = await runHook("session-end.js", endPayload(transcript2, "cap-8"));
    expect(second.code).toBe(0); // notice is once per 24h
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("reports a network failure on capture: stderr line and exit 1", async () => {
    const transcript = join(scratch, "cap-9.jsonl");
    copyFileSync(FIXTURE, transcript);
    const r = await runHook("session-end.js", endPayload(transcript, "cap-9"), { SECOND_BRAIN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\[Second Brain\] session capture failed:/);
  });

  it("honours SECOND_BRAIN_HOOK_CAPTURE_CURSOR without touching recall", async () => {
    const transcript = join(scratch, "cap-10.jsonl");
    copyFileSync(FIXTURE, transcript);
    const r = await runHook("session-end.js", endPayload(transcript, "cap-10"), { SECOND_BRAIN_HOOK_CAPTURE_CURSOR: "0" });
    expect(r.code, r.stderr).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("dry run prints the body and sends nothing", async () => {
    const transcript = join(scratch, "cap-11.jsonl");
    copyFileSync(FIXTURE, transcript);
    const r = await runHook("session-end.js", endPayload(transcript, "cap-11"), { SECOND_BRAIN_DRY_RUN: "1" });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ source: "cursor-session" });
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });
});

describe("stop event alias", () => {
  it("session-end.js also captures when invoked as the stop hook (same script, same transcript_path contract)", async () => {
    const transcript = join(scratch, "cap-stop-1.jsonl");
    copyFileSync(FIXTURE, transcript);
    const r = await runHook("session-end.js", endPayload(transcript, "cap-stop-1"));
    expect(r.code, r.stderr).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(1);
  });
});
