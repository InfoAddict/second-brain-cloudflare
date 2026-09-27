/**
 * Rahil's decision, 2026-09-27 (18-copy-deck.md section 6.8): cap a single saved note at 128 KB,
 * because very large pastes risk Cloudflare's 10 ms CPU limit. Measured as the stored content's
 * UTF-8 byte length, not its character or UTF-16 length — a script that reaches the cap sooner in
 * bytes than in characters (CJK, emoji) is exactly why the copy always says "about 20,000 words"
 * rather than a hard character count.
 */
export const MAX_CONTENT_BYTES = 131_072;

const encoder = new TextEncoder();

export function contentByteLength(text: string): number {
  return encoder.encode(text).length;
}

export function isOverContentLimit(text: string): boolean {
  return contentByteLength(text) > MAX_CONTENT_BYTES;
}

const REST_MESSAGE =
  "Too long to save as one memory: the limit is about 20,000 words. Nothing was saved. Split it into smaller memories.";

/** REST contract (director, 2026-09-27): the JSON body for a 413. */
export function tooLargeRestBody(): { ok: false; error: "too_large"; limit_bytes: number; message: string } {
  return { ok: false, error: "too_large", limit_bytes: MAX_CONTENT_BYTES, message: REST_MESSAGE };
}

const MCP_MESSAGE_DEFAULT =
  "Not saved: this is too long for one memory (the limit is about 20,000 words). Split it into smaller memories and save each one.";
// Append checks the RESULTING total, not the new text alone (director, 2026-09-27), and "split
// it" makes no sense for text already appended to an existing memory — copy deck 6.8's own truth
// check 2 gives this variant instead.
const MCP_MESSAGE_APPEND =
  "Not added: the memory would be too long (the limit is about 20,000 words). Save the new text as a separate memory.";

export function tooLargeMcpMessage(kind: "default" | "append" = "default"): string {
  return kind === "append" ? MCP_MESSAGE_APPEND : MCP_MESSAGE_DEFAULT;
}
