import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

// The real modules, not mirrors: see test/unit/claude-code-hooks.test.ts for
// why that matters. A mirror can pass while the real file drifts.
const start = require("../../integrations/cursor-hooks/session-start.js");
const beforeSubmit = require("../../integrations/cursor-hooks/before-submit-prompt.js");
const end = require("../../integrations/cursor-hooks/session-end.js");
const core = require("../../integrations/agent-hooks-core/core.js");

const FIXTURE = join(__dirname, "../../integrations/cursor-hooks/fixtures/sample-transcript.jsonl");
const tmp = () => mkdtempSync(join(tmpdir(), "sb-cursor-hooks-"));

describe("session-start.normalizeStdin", () => {
  it("prefers sessionId (camelCase) over session_id, the reverse priority from the Codex/Copilot family", () => {
    expect(start.normalizeStdin({ sessionId: "camel", session_id: "snake", cwd: "/x" }))
      .toEqual({ sessionId: "camel", cwd: "/x" });
  });

  it("falls back to session_id when sessionId is absent", () => {
    expect(start.normalizeStdin({ session_id: "snake", cwd: "/x" }).sessionId).toBe("snake");
  });

  it("defaults cwd to process.cwd() when absent or empty", () => {
    expect(start.normalizeStdin({}).cwd).toBe(process.cwd());
    expect(start.normalizeStdin({ cwd: "" }).cwd).toBe(process.cwd());
  });

  it("defaults sessionId to an empty string when absent", () => {
    expect(start.normalizeStdin({}).sessionId).toBe("");
  });

  it("tolerates null, non-object and malformed payloads without throwing", () => {
    expect(start.normalizeStdin(null)).toEqual({ sessionId: "", cwd: process.cwd() });
    expect(start.normalizeStdin(undefined)).toEqual({ sessionId: "", cwd: process.cwd() });
    expect(start.normalizeStdin("not an object")).toEqual({ sessionId: "", cwd: process.cwd() });
    expect(start.normalizeStdin(42)).toEqual({ sessionId: "", cwd: process.cwd() });
  });

  it("ignores non-string field values instead of coercing them", () => {
    expect(start.normalizeStdin({ sessionId: 123, cwd: null })).toEqual({ sessionId: "", cwd: process.cwd() });
  });

  it("before-submit-prompt.js re-exports the same normalizer", () => {
    expect(beforeSubmit.normalizeStdin).toBe(start.normalizeStdin);
  });
});

describe("session-start.emitAdditionalContext (output-shape builder)", () => {
  const captureStdout = (fn: () => void) => {
    const write = process.stdout.write.bind(process.stdout);
    let printed = "";
    // @ts-expect-error test spy
    process.stdout.write = (chunk: string) => { printed += String(chunk); return true; };
    try { fn(); } finally { process.stdout.write = write; }
    return printed;
  };

  it("writes the flat {additional_context} shape, not a nested hookSpecificOutput", () => {
    const printed = captureStdout(() => { start.emitAdditionalContext("hello world"); });
    const lines = printed.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed)).toEqual(["additional_context"]);
    expect(parsed.additional_context).toBe("hello world");
  });

  it("round-trips through JSON without altering the text", () => {
    const text = "[Second Brain] Context recalled ...\n----- second brain notes (begin) -----\n1. a note\n----- second brain notes (end) -----\n";
    const printed = captureStdout(() => { start.emitAdditionalContext(text); });
    expect(JSON.parse(printed).additional_context).toBe(text);
  });

  it("writes nothing, and returns false, for empty text", () => {
    let called = false;
    const write = process.stdout.write.bind(process.stdout);
    // @ts-expect-error test spy
    process.stdout.write = () => { called = true; return true; };
    let result: boolean;
    try { result = start.emitAdditionalContext(""); } finally { process.stdout.write = write; }
    expect(result!).toBe(false);
    expect(called).toBe(false);
  });
});

describe("session-end transcript parser", () => {
  it("extracts user turns from the fixture, oldest first, skipping the malformed line", () => {
    const turns = end.readUserTurns(FIXTURE);
    expect(turns).toHaveLength(3);
    expect(turns[0]).toContain("nightly digest");
    expect(turns[1]).toContain("25 entries per run");
    expect(turns[2]).toContain("early-stop log line");
    expect(turns.every((t: string) => typeof t === "string" && t.length > 0)).toBe(true);
  });

  it("never throws on a malformed or truncated line, and keeps the turns around it", () => {
    const dir = tmp();
    const file = join(dir, "bad.jsonl");
    writeFileSync(file, [
      '{"role":"user","content":"first turn is fine and long enough to count towards the gate for capture."}',
      '{"role":"user","content":"second turn got cut off mid-write and is not valid JSON at all',
      '{"role":"user","content":"third turn recovers after the bad line above and is captured normally."}',
    ].join("\n"));
    expect(() => end.readUserTurns(file)).not.toThrow();
    expect(end.readUserTurns(file)).toEqual([
      "first turn is fine and long enough to count towards the gate for capture.",
      "third turn recovers after the bad line above and is captured normally.",
    ]);
  });

  it("skips non-user roles, empty content and lines with no role at all", () => {
    const dir = tmp();
    const file = join(dir, "roles.jsonl");
    writeFileSync(file, [
      '{"role":"assistant","content":"assistant text, not captured"}',
      '{"role":"tool","content":"tool output, not captured"}',
      '{"role":"user","content":""}',
      '{"type":"session-info","sessionId":"x"}',
      '{"role":"user","content":"the only real user turn in this fixture, long enough to matter."}',
    ].join("\n"));
    expect(end.readUserTurns(file)).toEqual(["the only real user turn in this fixture, long enough to matter."]);
  });

  it("handles content as a plain string, an array of text blocks, and a {text} object", () => {
    const dir = tmp();
    const file = join(dir, "shapes.jsonl");
    writeFileSync(file, [
      '{"role":"user","content":"plain string content, long enough to count for the gate too."}',
      '{"role":"user","content":[{"type":"text","text":"array-shaped content, long enough to count for the gate."}]}',
      '{"role":"user","content":{"text":"object-shaped content, long enough to count for the gate too."}}',
    ].join("\n"));
    expect(end.readUserTurns(file)).toEqual([
      "plain string content, long enough to count for the gate too.",
      "array-shaped content, long enough to count for the gate.",
      "object-shaped content, long enough to count for the gate too.",
    ]);
  });

  it("turnFromLine tolerates blank lines and non-object JSON", () => {
    expect(end.turnFromLine("")).toBeNull();
    expect(end.turnFromLine("   ")).toBeNull();
    expect(end.turnFromLine("42")).toBeNull();
    expect(end.turnFromLine("null")).toBeNull();
    expect(end.turnFromLine('"just a string"')).toBeNull();
  });
});

describe("dedup marker logic (cursor-delivered) in isolation", () => {
  const withStub = async (handler: (u: URL) => { status: number; body: unknown } | null, run: () => Promise<unknown>) => {
    const realFetch = global.fetch;
    // @ts-expect-error test stub
    global.fetch = async (url: string) => {
      const u = new URL(String(url));
      const hit = handler(u);
      if (!hit) throw new Error("unreachable");
      return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "Content-Type": "application/json" } });
    };
    try { return await run(); } finally { global.fetch = realFetch; }
  };
  const env = { SECOND_BRAIN_URL: "https://w.example", SECOND_BRAIN_TOKEN: "t" };

  it("session-start sets the marker only when it actually delivers something", async () => {
    const dir = tmp();
    const text = await withStub(
      (u) => (u.pathname === "/recall" ? { status: 200, body: { ok: true, results: [], insight: null } }
        : u.pathname === "/brief" ? { status: 200, body: { ok: true } } : null),
      () => start.runSessionStart({ sessionId: "s1", cwd: dir }, { env, cacheDir: dir }),
    );
    expect(text).toBe("");
    expect(core.hasMarker("cursor-delivered", "s1", dir)).toBe(false);
  });

  it("session-start sets the marker when it delivers real context", async () => {
    const dir = tmp();
    const text = await withStub(
      (u) => (u.pathname === "/recall" ? { status: 200, body: { ok: true, results: [{ id: "m1", content: "a remembered thing" }], insight: null } }
        : u.pathname === "/brief" ? { status: 200, body: { ok: true } } : null),
      () => start.runSessionStart({ sessionId: "s2", cwd: dir }, { env, cacheDir: dir }),
    );
    expect(text).toContain("a remembered thing");
    expect(core.hasMarker("cursor-delivered", "s2", dir)).toBe(true);
  });

  it("before-submit-prompt runs once, then is a no-op for every later prompt in the same session", async () => {
    const dir = tmp();
    let recallCalls = 0;
    const realFetch = global.fetch;
    // @ts-expect-error test stub
    global.fetch = async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname === "/recall") {
        recallCalls++;
        return new Response(JSON.stringify({ ok: true, results: [{ id: "m1", content: "a remembered thing" }], insight: null }), { status: 200 });
      }
      if (u.pathname === "/brief") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response("{}", { status: 404 });
    };
    try {
      const overrides = { env, cacheDir: dir };
      expect(core.hasMarker("cursor-delivered", "s3", dir)).toBe(false);
      const first = await beforeSubmit.runBeforeSubmitPrompt({ sessionId: "s3", cwd: dir }, overrides);
      expect(first).toContain("a remembered thing");
      expect(core.hasMarker("cursor-delivered", "s3", dir)).toBe(true);
      expect(recallCalls).toBe(1);

      const second = await beforeSubmit.runBeforeSubmitPrompt({ sessionId: "s3", cwd: dir }, overrides);
      expect(second).toBeNull();
      expect(recallCalls).toBe(1); // no second request at all
    } finally { global.fetch = realFetch; }
  });

  it("before-submit-prompt does nothing when session-start already delivered, and makes no request", async () => {
    const dir = tmp();
    core.setMarker("cursor-delivered", "s4", dir);
    let calls = 0;
    const realFetch = global.fetch;
    // @ts-expect-error test stub
    global.fetch = async () => { calls++; return new Response("{}", { status: 404 }); };
    try {
      const out = await beforeSubmit.runBeforeSubmitPrompt({ sessionId: "s4", cwd: dir }, { env, cacheDir: dir });
      expect(out).toBeNull();
      expect(calls).toBe(0);
    } finally { global.fetch = realFetch; }
  });

  it("before-submit-prompt sets the marker even when its own recall finds nothing worth printing, so it never retries", async () => {
    const dir = tmp();
    let recallCalls = 0;
    const realFetch = global.fetch;
    // A result too short for frameOutput to render (filtered at < 4 chars) exits
    // performRecall's plan loop after the first arm, same as a real "nothing
    // useful" answer, so this stays a single recall call per invocation.
    // @ts-expect-error test stub
    global.fetch = async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname === "/recall") { recallCalls++; return new Response(JSON.stringify({ ok: true, results: [{ id: "m1", content: "  " }], insight: null }), { status: 200 }); }
      if (u.pathname === "/brief") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response("{}", { status: 404 });
    };
    try {
      const overrides = { env, cacheDir: dir };
      const first = await beforeSubmit.runBeforeSubmitPrompt({ sessionId: "s5", cwd: dir }, overrides);
      expect(first).toBe("");
      expect(core.hasMarker("cursor-delivered", "s5", dir)).toBe(true);
      await beforeSubmit.runBeforeSubmitPrompt({ sessionId: "s5", cwd: dir }, overrides);
      expect(recallCalls).toBe(1);
    } finally { global.fetch = realFetch; }
  });

  it("cursor-delivered, cursor (recall cache) and cursor-captured never collide", async () => {
    const dir = tmp();
    core.setMarker("cursor-delivered", "s6", dir);
    core.writeSessionCache("cursor", "s6", "cached recall block", dir);
    core.setMarker("cursor-captured", "s6", dir);
    expect(core.hasMarker("cursor-delivered", "s6", dir)).toBe(true);
    expect(core.readSessionCache("cursor", "s6", Date.now(), dir)).toBe("cached recall block");
    expect(core.hasMarker("cursor-captured", "s6", dir)).toBe(true);
  });
});
