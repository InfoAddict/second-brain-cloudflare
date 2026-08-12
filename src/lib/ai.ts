import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import { EMBEDDING_MODEL } from "../constants";

export function graceMs(env: Env): number {
  return parseInt(env.VECTORIZE_GRACE_MS ?? "300000", 10) || 300000;
}

function consumeSseLine(line: string, onText: (chunk: string) => void): void {
  if (!line.startsWith("data: ") || line.includes("[DONE]")) return;
  try {
    const d = JSON.parse(line.slice(6));
    if (d.response) onText(d.response);
  } catch (e) {
    // A parse failure here is on a COMPLETE line (buffering already held back
    // any partial one), so it's a genuine anomaly rather than a chunk-boundary
    // artifact — worth a log, but it must not interrupt the stream: dropping
    // one malformed SSE line is far better than losing everything read so far.
    console.error("readStreamText: malformed SSE line (non-fatal):", e);
  }
}

export async function readStreamText(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // { stream: true } holds back a trailing partial multi-byte sequence
    // until the bytes that complete it arrive in the next chunk.
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // The last element is either "" (buffer ended on a newline) or an
    // incomplete line — either way it isn't a complete line yet, so it stays
    // buffered for the next read rather than being parsed now.
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeSseLine(line, chunk => { text += chunk; });
  }
  // Flush any bytes the decoder was holding back for a not-yet-complete
  // multi-byte character.
  buffer += decoder.decode();
  reader.releaseLock();
  // The stream may end without a trailing newline after its last line —
  // process whatever is left in the buffer rather than dropping it.
  if (buffer) consumeSseLine(buffer, chunk => { text += chunk; });
  return text;
}

export async function embed(
  text: string,
  env: Env,
  config: Readonly<Config> = DEFAULTS,
): Promise<number[]> {
  // Workers AI requires `as any` here — the SDK types don't cover all models
  const result = (await env.AI.run(config.EMBEDDING_MODEL as any, { text: [text] })) as any;
  return result.data[0] as number[];
}
