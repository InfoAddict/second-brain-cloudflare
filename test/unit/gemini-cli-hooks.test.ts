import { describe, it, expect } from "vitest";

// The real module, not a mirror - see test/unit/claude-code-hooks.test.ts for why.
const start = require("../../integrations/gemini-cli-hooks/session-start.js");

describe("session-start.normalizeStdin", () => {
  it("reads session_id, cwd and source when present", () => {
    expect(start.normalizeStdin({ session_id: "s1", cwd: "/x/project", source: "startup" }))
      .toEqual({ sessionId: "s1", cwd: "/x/project", source: "startup" });
  });

  it("falls back to sessionId (camelCase) when session_id is absent", () => {
    expect(start.normalizeStdin({ sessionId: "s2", cwd: "/x/project", source: "startup" }))
      .toEqual({ sessionId: "s2", cwd: "/x/project", source: "startup" });
  });

  it("prefers session_id over sessionId when both are present", () => {
    expect(start.normalizeStdin({ session_id: "snake", sessionId: "camel", cwd: "/x", source: "startup" }).sessionId)
      .toBe("snake");
  });

  it("falls back to reason when source is absent", () => {
    expect(start.normalizeStdin({ cwd: "/x", reason: "clear" }).source).toBe("clear");
  });

  it("prefers source over reason when both are present", () => {
    expect(start.normalizeStdin({ cwd: "/x", source: "startup", reason: "clear" }).source).toBe("startup");
  });

  it("defaults source to startup when neither is present", () => {
    expect(start.normalizeStdin({ cwd: "/x" }).source).toBe("startup");
  });

  it("defaults cwd to process.cwd() when absent or empty", () => {
    expect(start.normalizeStdin({}).cwd).toBe(process.cwd());
    expect(start.normalizeStdin({ cwd: "" }).cwd).toBe(process.cwd());
  });

  it("defaults sessionId to an empty string when absent", () => {
    expect(start.normalizeStdin({}).sessionId).toBe("");
  });

  it("tolerates null, non-object and malformed payloads", () => {
    expect(start.normalizeStdin(null)).toEqual({ sessionId: "", cwd: process.cwd(), source: "startup" });
    expect(start.normalizeStdin(undefined)).toEqual({ sessionId: "", cwd: process.cwd(), source: "startup" });
    expect(start.normalizeStdin("not an object")).toEqual({ sessionId: "", cwd: process.cwd(), source: "startup" });
    expect(start.normalizeStdin(42)).toEqual({ sessionId: "", cwd: process.cwd(), source: "startup" });
  });

  it("ignores non-string field values instead of coercing them", () => {
    expect(start.normalizeStdin({ session_id: 123, cwd: null, source: false })).toEqual({
      sessionId: "", cwd: process.cwd(), source: "startup",
    });
  });
});

describe("session-start.buildOutput", () => {
  it("wraps the text in the hookSpecificOutput.additionalContext shape, JSON-only, newline-terminated", () => {
    const out = start.buildOutput("hello");
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hello" },
    });
  });

  it("emits nothing at all for empty text - not even `{}`", () => {
    expect(start.buildOutput("")).toBe("");
    expect(start.buildOutput(null)).toBe("");
    expect(start.buildOutput(undefined)).toBe("");
  });

  it("round-trips through JSON without altering the text", () => {
    const text = "[Second Brain] Context recalled ...\n----- second brain notes (begin) -----\n1. a note\n----- second brain notes (end) -----\n";
    const parsed = JSON.parse(start.buildOutput(text));
    expect(parsed.hookSpecificOutput.additionalContext).toBe(text);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("never starts with anything but `{` for the outer wrapper - no plain-text fallback", () => {
    const out = start.buildOutput("some context");
    expect(out.startsWith("{")).toBe(true);
  });
});

describe("session-start.SKIP_SOURCES", () => {
  it("skips only resume - startup and clear are fresh recalls, and there is no confirmed compact source", () => {
    expect(start.SKIP_SOURCES.has("resume")).toBe(true);
    expect(start.SKIP_SOURCES.has("startup")).toBe(false);
    expect(start.SKIP_SOURCES.has("clear")).toBe(false);
    expect(start.SKIP_SOURCES.has("compact")).toBe(false);
    expect(start.SKIP_SOURCES.has("fork")).toBe(false);
  });
});

describe("session-start.CAP_MS", () => {
  it("is exactly 3000 - the hard ceiling this adapter relies on against a synchronous, blocking CLI", () => {
    expect(start.CAP_MS).toBe(3000);
  });
});
