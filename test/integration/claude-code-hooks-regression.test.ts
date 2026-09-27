/**
 * Pins Claude Code's session-start hook against its own pre-refactor self.
 *
 * integrations/agent-hooks-core/core.js (T-0089.8) took over session-start.js's
 * logic so new adapters (Codex, Cursor, ...) could share it. A review caught a
 * real regression in an early version of that move: the shared core's default
 * timeout was cut to a single 3s cap for every provider, which would have cost
 * existing Claude Code users their recall on a slow or cold Worker (Claude's
 * SessionStart is not on the tight, synchronous clock some other hosts are).
 * The fix restored per-provider timing, with Claude's original 15s recall /
 * 3s brief-grace budget as performRecall()'s default.
 *
 * This test proves it stays fixed: it runs the FROZEN pre-refactor script
 * (fixtures/pre-shared-core.session-start.js) and the current session-start.js
 * against the identical stub Worker and stdin payload, and asserts their
 * stdout is byte-for-byte identical — including when the stub is slow enough
 * that the old 3s-cut version would have produced different (emptier) output
 * than the original 15s-budget version did.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterAll(cleanTemp);

const HOOKS = resolve(import.meta.dirname, "../../integrations/claude-code-hooks");
const CURRENT = join(HOOKS, "session-start.js");
const GOLDEN = join(HOOKS, "fixtures/pre-shared-core.session-start.js");

interface Behaviour { recallDelayMs?: number; briefDelayMs?: number }
let server: Server;
let origin = "";
let behaviour: Behaviour = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const send = () => {
      if (req.url?.startsWith("/recall")) return reply(200, { ok: true, results: [{ id: "m1", content: "a remembered thing", truncated: false }], insight: null });
      if (req.url?.startsWith("/brief")) return reply(200, { ok: true, attention: { due: 1 }, loops: { open: 0 } });
      return reply(200, { ok: true });
    };
    const delay = req.url?.startsWith("/recall") ? behaviour.recallDelayMs : req.url?.startsWith("/brief") ? behaviour.briefDelayMs : undefined;
    delay ? setTimeout(send, delay) : send();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let scratch: string;
let project: string;

beforeEach(() => {
  behaviour = {};
  scratch = mkdtempSync(join(tmpdir(), "sb-hooks-regress-"));
  project = join(scratch, "brain-app");
  mkdirSync(project);
});
afterEach(cleanTemp);

function runHook(script: string, payload: object) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((done, fail) => {
    const started = Date.now();
    const child = spawn("node", [script], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: scratch, XDG_CACHE_HOME: join(scratch, "cache"),
        SECOND_BRAIN_URL: origin, SECOND_BRAIN_TOKEN: "test-token",
      } as unknown as NodeJS.ProcessEnv,
      stdio: "pipe",
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const payload = { session_id: "s1", cwd: project, hook_event_name: "SessionStart", source: "startup" };

describe("Claude Code session-start.js vs. its frozen pre-shared-core self", () => {
  it("produces byte-for-byte identical stdout on the plain path", async () => {
    const [current, golden] = await Promise.all([runHook(CURRENT, payload), runHook(GOLDEN, payload)]);
    expect(current.code).toBe(0);
    expect(golden.code).toBe(0);
    expect(current.stdout).toBe(golden.stdout);
    expect(current.stdout).toContain("a remembered thing");
  });

  it("still recalls when the Worker takes 10s to answer — well past a 3s cap, well inside the original 15s budget", async () => {
    behaviour.recallDelayMs = 10000;
    const [current, golden] = await Promise.all([runHook(CURRENT, payload), runHook(GOLDEN, payload)]);
    expect(current.code, current.stderr).toBe(0);
    expect(golden.code, golden.stderr).toBe(0);
    // A 3s-capped version would have failed here (recall timeout) and printed
    // nothing; the original 15s-budget version succeeds. Both must agree.
    expect(current.stdout).toBe(golden.stdout);
    expect(current.stdout).toContain("a remembered thing");
  }, 20000);

  it("keeps the brief's ~3s grace after recall answers, matching the original exactly", async () => {
    behaviour.briefDelayMs = 8000;
    const [current, golden] = await Promise.all([runHook(CURRENT, payload), runHook(GOLDEN, payload)]);
    expect(current.code).toBe(0);
    expect(golden.code).toBe(0);
    expect(current.stdout).toBe(golden.stdout);
    expect(current.stdout).not.toContain("Due:"); // the 8s brief never made the ~3s grace window, in either version
    // Both should finish in roughly the same window: recall answers quickly,
    // then a bounded ~3s grace for the brief, not 8s and not 3s a from a
    // combined-with-recall cap.
    expect(current.ms).toBeLessThan(6000);
    expect(golden.ms).toBeLessThan(6000);
  }, 20000);
});
