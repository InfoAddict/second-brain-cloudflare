/**
 * Rahil's decision (18-copy-deck.md section 6.8): cap a single saved note at 128 KB (131,072
 * bytes), measured as the stored content's UTF-8 byte length, because very large pastes risk
 * Cloudflare's 10 ms CPU limit. Applied on every write path that takes note content.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_CONTENT_BYTES, contentByteLength, isOverContentLimit, tooLargeRestBody, tooLargeMcpMessage,
} from "../../src/lib/content-size";

describe("MAX_CONTENT_BYTES", () => {
  it("is exactly 128 KiB", () => {
    expect(MAX_CONTENT_BYTES).toBe(131_072);
  });
});

describe("contentByteLength", () => {
  it("counts ASCII characters one byte each", () => {
    expect(contentByteLength("a".repeat(100))).toBe(100);
  });

  it("counts a multi-byte character's real UTF-8 byte length, not its string length", () => {
    // "日" is one UTF-16 code unit but 3 UTF-8 bytes.
    expect(contentByteLength("日")).toBe(3);
    expect("日".length).toBe(1);
  });
});

describe("isOverContentLimit", () => {
  it("is false at exactly the limit", () => {
    expect(isOverContentLimit("a".repeat(MAX_CONTENT_BYTES))).toBe(false);
  });

  it("is true one byte over the limit", () => {
    expect(isOverContentLimit("a".repeat(MAX_CONTENT_BYTES + 1))).toBe(true);
  });
});

describe("tooLargeRestBody", () => {
  it("matches the fixed contract", () => {
    expect(tooLargeRestBody()).toEqual({
      ok: false,
      error: "too_large",
      limit_bytes: 131_072,
      message: "Too long to save as one memory: the limit is about 20,000 words. Nothing was saved. Split it into smaller memories.",
    });
  });
});

describe("tooLargeMcpMessage", () => {
  it("default (remember, update): starts \"Not saved\"", () => {
    expect(tooLargeMcpMessage()).toBe(
      "Not saved: this is too long for one memory (the limit is about 20,000 words). Split it into smaller memories and save each one.",
    );
  });

  it("append variant checks the resulting total, and reads \"Not added\"", () => {
    expect(tooLargeMcpMessage("append")).toBe(
      "Not added: the memory would be too long (the limit is about 20,000 words). Save the new text as a separate memory.",
    );
  });
});
