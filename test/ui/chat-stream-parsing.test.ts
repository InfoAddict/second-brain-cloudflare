/**
 * The dashboard's /chat reader (public/js/recall.js) independently parses
 * Workers AI's SSE stream, because POST /chat (src/routes/recall.ts)
 * streams the raw response straight to the browser instead of going
 * through src/lib/ai.ts's readStreamText. Same two answer shapes, same
 * chunk-boundary hazard, kept in sync by hand — this is the browser-side
 * counterpart to test/unit/read-stream-text.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function load(): any {
  const ctx: any = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/recall.js"), "utf8"), ctx);
  return ctx;
}

describe("extractChatChunkText()", () => {
  it("reads the Llama-shape d.response field", () => {
    const ctx = load();
    expect(ctx.extractChatChunkText({ response: "hi" })).toBe("hi");
  });

  it("reads the OpenAI-shape choices[0].delta.content field", () => {
    const ctx = load();
    expect(ctx.extractChatChunkText({ choices: [{ delta: { content: "hi" } }] })).toBe("hi");
  });

  it("never returns delta.reasoning or delta.reasoning_content", () => {
    const ctx = load();
    const d = { choices: [{ delta: { reasoning: "think", reasoning_content: "think" } }] };
    expect(ctx.extractChatChunkText(d)).toBe("");
  });

  it("tolerates choices: [], a missing delta, and a missing content without throwing", () => {
    const ctx = load();
    expect(() => ctx.extractChatChunkText({ choices: [] })).not.toThrow();
    expect(ctx.extractChatChunkText({ choices: [] })).toBe("");
    expect(ctx.extractChatChunkText({ choices: [{}] })).toBe("");
    expect(ctx.extractChatChunkText({ choices: [{ delta: {} }] })).toBe("");
    expect(ctx.extractChatChunkText({})).toBe("");
    expect(ctx.extractChatChunkText(null)).toBe("");
  });
});

describe("consumeChatSseLine()", () => {
  it("calls onText with the extracted content for a data line", () => {
    const ctx = load();
    let out = "";
    ctx.consumeChatSseLine('data: {"response":"hello"}', (t: string) => (out += t));
    expect(out).toBe("hello");
  });

  it("ignores [DONE] and non-data lines", () => {
    const ctx = load();
    const onText = vi.fn();
    ctx.consumeChatSseLine("data: [DONE]", onText);
    ctx.consumeChatSseLine(": comment", onText);
    ctx.consumeChatSseLine("", onText);
    expect(onText).not.toHaveBeenCalled();
  });

  it("swallows a malformed complete line without throwing", () => {
    const ctx = load();
    expect(() => ctx.consumeChatSseLine("data: not-json", () => {})).not.toThrow();
  });
});

describe("feedChatStream() — assembling the /chat answer", () => {
  it("assembles an OpenAI-shape answer delivered across several complete lines", () => {
    const ctx = load();
    let fullText = "";
    const onText = (t: string) => (fullText += t);
    let buffer = "";
    buffer = ctx.feedChatStream(buffer, 'data: {"choices":[{"delta":{"content":"Hello","role":"assistant"}}]}\n', onText);
    buffer = ctx.feedChatStream(buffer, 'data: {"choices":[{"delta":{"content":" from"}}]}\n', onText);
    buffer = ctx.feedChatStream(buffer, 'data: {"choices":[{"delta":{"content":" gpt-oss"}}]}\ndata: [DONE]\n', onText);
    expect(fullText).toBe("Hello from gpt-oss");
  });

  it("still handles the Llama d.response shape unchanged", () => {
    const ctx = load();
    let fullText = "";
    ctx.feedChatStream("", 'data: {"response":"the quick brown fox"}\n', (t: string) => (fullText += t));
    expect(fullText).toBe("the quick brown fox");
  });

  it("excludes reasoning fields from the assembled answer, even when they arrive first", () => {
    const ctx = load();
    let fullText = "";
    const onText = (t: string) => (fullText += t);
    let buffer = ctx.feedChatStream("", 'data: {"choices":[{"delta":{"reasoning":"We","reasoning_content":"We"}}]}\n', onText);
    buffer = ctx.feedChatStream(buffer, 'data: {"choices":[{"delta":{"reasoning":" need to think.","reasoning_content":" need to think."}}]}\n', onText);
    ctx.feedChatStream(buffer, 'data: {"choices":[{"delta":{"content":"42"}}]}\n', onText);
    expect(fullText).toBe("42");
  });

  it("reassembles an SSE line split across a network chunk boundary", () => {
    const ctx = load();
    let fullText = "";
    const onText = (t: string) => (fullText += t);
    const line = 'data: {"choices":[{"delta":{"content":"streamed across a boundary"}}]}\n';
    const splitAt = 40; // lands inside the JSON string value, not on a line boundary
    let buffer = ctx.feedChatStream("", line.slice(0, splitAt), onText);
    // Nothing should render yet — the line isn't complete, so it must stay buffered.
    expect(fullText).toBe("");
    ctx.feedChatStream(buffer, line.slice(splitAt), onText);
    expect(fullText).toBe("streamed across a boundary");
  });

  it("holds back a final line with no trailing newline until the caller flushes it", () => {
    const ctx = load();
    let fullText = "";
    const onText = (t: string) => (fullText += t);
    const buffer = ctx.feedChatStream("", 'data: {"response":"tail-no-newline"}', onText);
    expect(fullText).toBe("");
    ctx.consumeChatSseLine(buffer, onText); // what sendRecall does once the reader is done
    expect(fullText).toBe("tail-no-newline");
  });
});
