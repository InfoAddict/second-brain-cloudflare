import { describe, it, expect, vi } from "vitest";
import { readStreamText } from "../../src/lib/ai";
import { synthesizeInsight } from "../../src/recall/insight";
import { makeTestEnv } from "../helpers/make-env";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream {
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
}

function streamFromStrings(chunks: string[]): ReadableStream {
  const enc = new TextEncoder();
  return streamFromChunks(chunks.map(s => enc.encode(s)));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

describe("readStreamText()", () => {
  it("reassembles a single SSE line split across two chunks at an arbitrary byte offset", async () => {
    const line = 'data: {"response":"the quick brown fox jumps"}\n';
    const bytes = new TextEncoder().encode(line);
    // Split well inside the line, not on a chunk/line boundary.
    const splitAt = 20;
    const stream = streamFromChunks([bytes.slice(0, splitAt), bytes.slice(splitAt)]);
    expect(await readStreamText(stream)).toBe("the quick brown fox jumps");
  });

  it("reassembles a single SSE line split across three chunks", async () => {
    const line = 'data: {"response":"reassembled across three reads"}\n';
    const bytes = new TextEncoder().encode(line);
    const a = Math.floor(bytes.length / 3);
    const b = Math.floor((2 * bytes.length) / 3);
    const stream = streamFromChunks([bytes.slice(0, a), bytes.slice(a, b), bytes.slice(b)]);
    expect(await readStreamText(stream)).toBe("reassembled across three reads");
  });

  it("decodes a multi-byte UTF-8 character split across a chunk boundary", async () => {
    // é is two UTF-8 bytes (0xC3 0xA9). Split the line so those two bytes land
    // in different chunks — decoding each chunk in isolation mangles it into
    // replacement characters; only a stateful decoder across chunks gets it right.
    const prefix = new TextEncoder().encode('data: {"response":"caf');
    const eBytes = new TextEncoder().encode("é");
    const suffix = new TextEncoder().encode(' time \u{1F389}"}\n'); // trailing emoji for good measure

    const chunk1 = concatBytes(prefix, eBytes.slice(0, 1));
    const chunk2 = concatBytes(eBytes.slice(1), suffix);
    const stream = streamFromChunks([chunk1, chunk2]);
    expect(await readStreamText(stream)).toBe("café time \u{1F389}");
  });

  it("processes a final line with no trailing newline", async () => {
    const stream = streamFromStrings([
      'data: {"response":"first"}\n',
      'data: {"response":"tail-no-newline"}',
    ]);
    expect(await readStreamText(stream)).toBe("firsttail-no-newline");
  });

  it("processes multiple complete lines delivered in a single chunk, in order", async () => {
    const stream = streamFromStrings([
      'data: {"response":"A"}\ndata: {"response":"B"}\ndata: {"response":"C"}\n',
    ]);
    expect(await readStreamText(stream)).toBe("ABC");
  });

  it("skips [DONE] and tolerates a malformed complete line without throwing", async () => {
    const stream = streamFromStrings([
      'data: {"response":"before"}\n',
      "data: not-json-at-all\n",
      'data: {"response":"after"}\n',
      "data: [DONE]\n",
    ]);
    await expect(readStreamText(stream)).resolves.toBe("beforeafter");
  });

  it("logs a non-fatal error for a malformed COMPLETE line, but not for a partial-line artifact of buffering", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stream = streamFromStrings([
        'data: {"response":"ok"}\n',
        "data: {broken json\n",
      ]);
      await readStreamText(stream);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatch(/non-fatal/);
    } finally {
      spy.mockRestore();
    }
  });

  it("end-to-end: synthesizeInsight assembles the full text from a chunk-split stream", async () => {
    // Split a real caller's SSE line across a chunk boundary the way a live
    // network stream would, and confirm the caller sees the complete text
    // rather than a truncated fragment.
    const line = 'data: {"response":"Auth strategy settled on JWT with short-lived refresh tokens."}\n';
    const bytes = new TextEncoder().encode(line);
    const splitAt = 37; // lands inside the JSON string value
    const stream = streamFromChunks([bytes.slice(0, splitAt), bytes.slice(splitAt)]);

    const env = makeTestEnv(undefined, {
      AI: { run: vi.fn().mockResolvedValue(stream) } as unknown as Ai,
    });

    const result = await synthesizeInsight(
      "auth strategy",
      [{ id: "1", content: "We chose JWT with 1hr expiry" }],
      env
    );
    expect(result).toBe("Auth strategy settled on JWT with short-lived refresh tokens.");
  });
});
