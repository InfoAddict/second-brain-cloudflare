/**
 * T3/T4 task H (16-t3-t4-trust-spec.md, "H: hook line"): "one line naming tools, holds and
 * groups, under 300 characters, identical across the Claude Code, Codex, Cursor, Copilot and
 * Gemini adapters." All five adapters' session-start.js delegate to the same
 * integrations/agent-hooks-core/core.js (compactBriefLines/changesLine), so this spawns the five
 * REAL scripts against one stub Worker and checks the printed changes-line text is byte-for-byte
 * identical across every one of them -- proving the shared core, not just asserting it by reading
 * the require() graph.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterAll(cleanTemp);

const ROOT = resolve(import.meta.dirname, "../../integrations");

let server: Server;
let origin = "";
let briefChanges: unknown = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.url?.startsWith("/recall")) return reply(200, { ok: true, results: [], insight: null });
    if (req.url?.startsWith("/brief")) {
      return reply(200, { ok: true, attention: { due: 0 }, loops: { open: 0, items: [] }, changes: briefChanges });
    }
    return reply(200, { ok: true });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function runNode(script: string, cwd: string, env: NodeJS.ProcessEnv, stdin: unknown) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn("node", [script], { cwd, env, stdio: "pipe" });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

interface AdapterSpec {
  name: string;
  script: string;
  /** Where the process itself runs -- Cursor's real host runs hooks from ~/.cursor, not the project. */
  cwd: (scratch: string, project: string) => string;
  payload: (project: string) => object;
  /** Pulls the printed context text out of stdout, whatever envelope this adapter wraps it in. */
  extract: (stdout: string) => string;
}

const ADAPTERS: AdapterSpec[] = [
  {
    name: "Claude Code",
    script: join(ROOT, "claude-code-hooks/session-start.js"),
    cwd: (_scratch, project) => project,
    payload: (project) => ({ session_id: "s1", cwd: project, hook_event_name: "SessionStart", source: "startup" }),
    extract: (stdout) => stdout,
  },
  {
    name: "Codex",
    script: join(ROOT, "codex-cli-hooks/session-start.js"),
    cwd: (_scratch, project) => project,
    payload: (project) => ({ session_id: "s1", cwd: project, hook_event_name: "SessionStart", source: "startup" }),
    extract: (stdout) => stdout.trim() ? JSON.parse(stdout.trim().split("\n")[0]).hookSpecificOutput.additionalContext : "",
  },
  {
    name: "Cursor",
    script: join(ROOT, "cursor-hooks/session-start.js"),
    cwd: (scratch) => join(scratch, ".cursor"),
    payload: (project) => ({ conversation_id: "conv-1", session_id: "sess-conv-1", hook_event_name: "sessionStart", workspace_roots: [project] }),
    extract: (stdout) => stdout.trim() ? JSON.parse(stdout.trim().split("\n")[0]).additional_context : "",
  },
  {
    name: "VS Code Copilot",
    script: join(ROOT, "vscode-copilot-hooks/session-start.js"),
    cwd: (_scratch, project) => project,
    payload: (project) => ({ session_id: "s1", cwd: project, source: "startup" }),
    extract: (stdout) => stdout.trim() ? JSON.parse(stdout.trim().split("\n")[0]).hookSpecificOutput.additionalContext : "",
  },
  {
    name: "Gemini CLI",
    script: join(ROOT, "gemini-cli-hooks/session-start.js"),
    cwd: (_scratch, project) => project,
    payload: (project) => ({ session_id: "s1", cwd: project, source: "startup" }),
    extract: (stdout) => stdout.trim() ? JSON.parse(stdout.trim().split("\n")[0]).hookSpecificOutput.additionalContext : "",
  },
];

async function runAdapter(a: AdapterSpec): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "sb-hooks-changes-"));
  const project = join(scratch, "project");
  mkdirSync(project, { recursive: true });
  const cwd = a.cwd(scratch, project);
  mkdirSync(cwd, { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: scratch, XDG_CACHE_HOME: join(scratch, "cache"),
    SECOND_BRAIN_URL: origin, SECOND_BRAIN_TOKEN: "test-token",
  } as unknown as NodeJS.ProcessEnv;
  const res = await runNode(a.script, cwd, env, a.payload(project));
  expect(res.code, `${a.name} exited ${res.code}: ${res.stderr}`).toBe(0);
  return a.extract(res.stdout);
}

/** The changes line is the only thing this test cares about; the rest of each adapter's envelope
 * (recall framing, JSON wrapper shape) legitimately differs and is covered by that adapter's own
 * contract test. */
const CHANGES_LINE_RE = /^(Changed by AI tools:.*|Held:.*)$/m;

describe("the changes line is identical across every adapter (task H)", () => {
  it("names the tool, the count and undo, byte-identical for Claude Code, Codex, Cursor, Copilot and Gemini", async () => {
    briefChanges = { held: 0, groups: [{ family: "canonical_edit", count: 1, client: "test-client", at: Date.now() - 8 * 60 * 1000 }] };
    const texts = await Promise.all(ADAPTERS.map((a) => runAdapter(a)));

    const lines = texts.map((t, i) => {
      const m = t.match(CHANGES_LINE_RE);
      expect(m, `${ADAPTERS[i].name} printed no changes line in: ${t}`).not.toBeNull();
      return m![0];
    });

    expect(new Set(lines).size).toBe(1);
    expect(lines[0]).toContain('Changed by AI tools: 1 edit to trusted memories via "test-client"');
    expect(lines[0]).toContain('The user can say "undo all" to reverse them.');
    expect(lines[0].length).toBeLessThanOrEqual(300);
  }, 20000);

  it("is silent (no changes line at all) when there is nothing eligible, for every adapter", async () => {
    briefChanges = { held: 0, groups: [] };
    const texts = await Promise.all(ADAPTERS.map((a) => runAdapter(a)));
    texts.forEach((t, i) => expect(t, ADAPTERS[i].name).not.toMatch(CHANGES_LINE_RE));
  }, 20000);
});
