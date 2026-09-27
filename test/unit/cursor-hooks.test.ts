import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

// The real modules, not mirrors: see test/unit/claude-code-hooks.test.ts for
// why that matters. A mirror can pass while the real file drifts.
const start = require("../../integrations/cursor-hooks/session-start.js");
const end = require("../../integrations/cursor-hooks/session-end.js");

const FIXTURE = join(__dirname, "../../integrations/cursor-hooks/fixtures/sample-transcript.jsonl");
const REAL_SHAPE = join(__dirname, "../../integrations/cursor-hooks/fixtures/real-shape-transcript.jsonl");
const tmp = () => mkdtempSync(join(tmpdir(), "sb-cursor-hooks-"));

describe("session-start.normalizeStdin", () => {
  it("keys the session on conversation_id, the id every documented event carries", () => {
    expect(start.normalizeStdin({ conversation_id: "conv", session_id: "sess", workspace_roots: ["/x"] }))
      .toEqual({ sessionId: "conv", cwd: "/x" });
  });

  it("falls back to sessionId, then session_id, when conversation_id is absent", () => {
    expect(start.normalizeStdin({ sessionId: "camel", session_id: "snake", cwd: "/x" }).sessionId).toBe("camel");
    expect(start.normalizeStdin({ session_id: "snake", cwd: "/x" }).sessionId).toBe("snake");
  });

  it("takes the project from workspace_roots[0], never the hooks directory the process runs in", () => {
    expect(start.normalizeStdin({ workspace_roots: ["/work/app", "/work/lib"], cwd: "/home/u/.cursor" }).cwd).toBe("/work/app");
  });

  it("defaults cwd to process.cwd() when absent or empty", () => {
    expect(start.normalizeStdin({}).cwd).toBe(process.cwd());
    expect(start.normalizeStdin({ cwd: "", workspace_roots: [] }).cwd).toBe(process.cwd());
  });

  it("tolerates null, non-object and malformed payloads without throwing", () => {
    expect(start.normalizeStdin(null)).toEqual({ sessionId: "", cwd: process.cwd() });
    expect(start.normalizeStdin(undefined)).toEqual({ sessionId: "", cwd: process.cwd() });
    expect(start.normalizeStdin("not an object")).toEqual({ sessionId: "", cwd: process.cwd() });
    expect(start.normalizeStdin(42)).toEqual({ sessionId: "", cwd: process.cwd() });
  });

  it("ignores non-string field values instead of coercing them", () => {
    expect(start.normalizeStdin({ conversation_id: 123, workspace_roots: [null], cwd: null })).toEqual({ sessionId: "", cwd: process.cwd() });
  });
});

describe("session-start.emitAdditionalContext (output-shape builder)", () => {
  const captureStdout = (fn: () => void) => {
    const write = process.stdout.write.bind(process.stdout);
    let printed = "";
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
    process.stdout.write = () => { called = true; return true; };
    let result: boolean;
    try { result = start.emitAdditionalContext(""); } finally { process.stdout.write = write; }
    expect(result!).toBe(false);
    expect(called).toBe(false);
  });
});

describe("session-end transcript parser", () => {
  it("reads the real Cursor record shape (message.content blocks) and unwraps <user_query>", () => {
    const turns = end.readUserTurns(REAL_SHAPE);
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatch(/^Let's wire the nightly digest/);
    expect(turns[1]).toMatch(/^Also cap it at 25/);
    expect(turns[2]).toMatch(/^Actually hold off on shipping/);
    expect(turns.join("\n")).not.toMatch(/<user_query>|<timestamp>/);
  });

  it("userQueryText keeps only the typed query, or strips the timestamp when there is no wrapper", () => {
    expect(end.userQueryText("<timestamp>Sun</timestamp>\n<user_query>\nhello there\n</user_query>")).toBe("hello there");
    expect(end.userQueryText("<timestamp>Sun</timestamp> plain text")).toBe("plain text");
  });

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
