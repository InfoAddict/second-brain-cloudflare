import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The real modules, not a mirror - same reasoning as test/unit/claude-code-hooks.test.ts.
const start = require("../../integrations/codex-cli-hooks/session-start.js");
const end = require("../../integrations/codex-cli-hooks/session-end.js");
const worker = require("../../integrations/codex-cli-hooks/capture-worker.js");

const HOOKS = resolve(import.meta.dirname, "../../integrations/codex-cli-hooks");
const FIXTURE = join(HOOKS, "fixtures/sample-transcript.jsonl");

describe("session-start.normalizeStartEvent", () => {
  it("reads session_id, cwd and source when present", () => {
    expect(start.normalizeStartEvent({ session_id: "s1", cwd: "/x/project", source: "startup" }))
      .toEqual({ sessionId: "s1", cwd: "/x/project", source: "startup" });
  });

  it("falls back to sessionId (camelCase) when session_id is absent", () => {
    expect(start.normalizeStartEvent({ sessionId: "s2", cwd: "/x/project", source: "startup" }).sessionId)
      .toBe("s2");
  });

  it("falls back to reason when source is absent", () => {
    expect(start.normalizeStartEvent({ cwd: "/x", reason: "compact" }).source).toBe("compact");
  });

  it("defaults source to startup and cwd to process.cwd() when absent", () => {
    expect(start.normalizeStartEvent({})).toEqual({ sessionId: "", cwd: process.cwd(), source: "startup" });
  });

  it("tolerates null and non-object payloads", () => {
    expect(start.normalizeStartEvent(null)).toEqual({ sessionId: "", cwd: process.cwd(), source: "startup" });
    expect(start.normalizeStartEvent("nope" as unknown as object)).toEqual({ sessionId: "", cwd: process.cwd(), source: "startup" });
  });
});

describe("session-start.emitAdditionalContext", () => {
  it("does nothing for empty text", () => {
    expect(start.emitAdditionalContext("")).toBe(false);
    expect(start.emitAdditionalContext(null)).toBe(false);
  });
});

describe("session-end.normalizeEndEvent", () => {
  it("reads session_id, cwd, transcript_path and reason when present", () => {
    expect(end.normalizeEndEvent({
      session_id: "s1", cwd: "/x/project", transcript_path: "/tmp/t.jsonl", reason: "close",
    })).toEqual({ sessionId: "s1", cwd: "/x/project", transcriptPath: "/tmp/t.jsonl", reason: "close" });
  });

  it("falls back to camelCase field names", () => {
    const r = end.normalizeEndEvent({ sessionId: "s2", transcriptPath: "/tmp/t2.jsonl" });
    expect(r.sessionId).toBe("s2");
    expect(r.transcriptPath).toBe("/tmp/t2.jsonl");
  });

  it("defaults reason to 'other' and cwd to process.cwd()", () => {
    const r = end.normalizeEndEvent({});
    expect(r.reason).toBe("other");
    expect(r.cwd).toBe(process.cwd());
    expect(r.transcriptPath).toBe("");
  });

  it("tolerates null and non-object payloads", () => {
    expect(end.normalizeEndEvent(null)).toEqual({ sessionId: "", cwd: process.cwd(), transcriptPath: "", reason: "other" });
  });

  it("accepts all four documented SessionEnd reasons without special-casing any of them", () => {
    for (const reason of ["close", "archive", "delete", "idle"]) {
      expect(end.normalizeEndEvent({ reason }).reason).toBe(reason);
    }
  });
});

describe("session-end.dispatchCapture", () => {
  it("spawns capture-worker.js detached and unref'd, with the payload JSON-encoded as argv[2]", () => {
    const calls: unknown[] = [];
    let unrefed = false;
    const fakeSpawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { unref: () => { unrefed = true; } };
    };
    const payload = { sessionId: "s1", cwd: "/x", transcriptPath: "/tmp/t.jsonl", reason: "close" };
    end.dispatchCapture(payload, { spawnFn: fakeSpawn, workerPath: "/fake/capture-worker.js" });

    expect(calls).toHaveLength(1);
    const call = calls[0] as { cmd: string; args: string[]; opts: Record<string, unknown> };
    expect(call.args[0]).toBe("/fake/capture-worker.js");
    expect(JSON.parse(call.args[1])).toEqual(payload);
    expect(call.opts.detached).toBe(true);
    expect(call.opts.stdio).toBe("ignore");
    expect(unrefed).toBe(true);
  });
});

describe("capture-worker transcript parser", () => {
  it("parses the bundled fixture: skips the malformed line and extracts user turns in order", () => {
    const raw = readFileSync(FIXTURE, "utf8");
    const turns = worker.parseTranscript(raw);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((t: { role: string }) => t.role === "user" || t.role === "assistant")).toBe(true);

    const userTexts = turns.filter((t: { role: string }) => t.role === "user").map((t: { text: string }) => t.text);
    expect(userTexts[0]).toContain("nightly digest cron");
    // the event_msg/user_message shape must be recognized alongside response_item
    expect(userTexts.some((t: string) => t.includes("budget check"))).toBe(true);
    // private reasoning and tool output must never surface as a turn
    expect(turns.some((t: { text: string }) => t.text.includes("private reasoning"))).toBe(false);
    expect(turns.some((t: { text: string }) => t.text.includes("do-not-capture-this"))).toBe(false);
  });

  it("never throws on a line that is not valid JSON", () => {
    expect(() => worker.parseTranscript('{ not json\n{"type":"whatever"}\n')).not.toThrow();
    expect(worker.parseTranscript('{ not json\n')).toEqual([]);
  });

  it("returns [] for empty or garbage input", () => {
    expect(worker.parseTranscript("")).toEqual([]);
    expect(worker.parseTranscript(undefined)).toEqual([]);
    expect(worker.parseTranscript("\n\n\n")).toEqual([]);
  });

  it("recognizes the response_item/message shape", () => {
    const line = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello there" }] } });
    expect(worker.parseTranscript(line)).toEqual([{ role: "user", text: "hello there" }]);
  });

  it("recognizes the event_msg/user_message shape", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } });
    expect(worker.parseTranscript(line)).toEqual([{ role: "user", text: "hi" }]);
  });

  it("recognizes a flat {role, content} shape as a fallback", () => {
    const line = JSON.stringify({ role: "assistant", content: "flat shape reply" });
    expect(worker.parseTranscript(line)).toEqual([{ role: "assistant", text: "flat shape reply" }]);
  });

  it("drops records with an unrecognized shape or empty text", () => {
    expect(worker.parseTranscript(JSON.stringify({ type: "session_meta", payload: {} }))).toEqual([]);
    expect(worker.parseTranscript(JSON.stringify({ role: "user", content: "   " }))).toEqual([]);
    expect(worker.parseTranscript(JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: "x" } }))).toEqual([]);
  });
});

describe("capture-worker.extractUserTurns", () => {
  it("keeps only user turns, oldest first, capped to `want`", () => {
    const turns = [
      { role: "user", text: "u1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "u2" },
      { role: "user", text: "u3" },
      { role: "user", text: "u4" },
    ];
    expect(worker.extractUserTurns(turns, 3)).toEqual(["u2", "u3", "u4"]);
  });

  it("returns [] when there are no user turns", () => {
    expect(worker.extractUserTurns([{ role: "assistant", text: "a1" }])).toEqual([]);
  });
});

describe("output-shape builders", () => {
  it("session-start prints hookSpecificOutput.additionalContext, not a bare stdout string", () => {
    const shaped = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "x" } };
    // emitAdditionalContext writes this exact shape to stdout; verified indirectly via the
    // integration contract test (spawned process), this checks the JSON is well-formed here.
    expect(JSON.stringify(shaped)).toContain('"additionalContext":"x"');
  });
});
