import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import { EMBEDDING_MODEL } from "../constants";

export function graceMs(env: Env): number {
  return parseInt(env.VECTORIZE_GRACE_MS ?? "300000", 10) || 300000;
}

/**
 * Workers AI streams two different answer shapes depending on model lineage.
 * Llama-family models (the shipped default) put the text directly on
 * `response`. OpenAI-lineage models (`@cf/openai/gpt-oss-*`) stream an
 * OpenAI-style chat-completion delta instead, under `choices[0].delta.content`
 * — and the reasoning ones in that family emit chain-of-thought first, as
 * `delta.reasoning` / `delta.reasoning_content`, before any `delta.content`.
 * That chain-of-thought is deliberately never returned here: every caller of
 * `readStreamText` treats the result as the answer — JSON.parse'ing it or
 * feeding it straight into a digest — not as reasoning prose.
 *
 * POST /chat (src/routes/recall.ts) is the one caller that does NOT go
 * through `readStreamText` — it streams the raw Workers AI response
 * straight to the browser, so public/js/recall.js hand-mirrors this exact
 * function (extractChatChunkText) and the buffering below it. Keep the two
 * in sync: a change here is a prompt to check there, and vice versa.
 */
function extractChunkText(d: any): string {
  if (d?.response) return d.response;
  const content = d?.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : "";
}

function consumeSseLine(line: string, onText: (chunk: string) => void): void {
  if (!line.startsWith("data:")) return;
  // SSE permits exactly one optional space after the field colon.
  const payload = line.slice(line.startsWith("data: ") ? 6 : 5);
  // The completion sentinel is the WHOLE payload, never a substring of one —
  // an answer may legitimately contain the text "[DONE]". trimEnd() tolerates
  // the trailing \r a CRLF stream leaves after splitting on \n.
  if (payload.trimEnd() === "[DONE]") return;
  try {
    const d = JSON.parse(payload);
    const text = extractChunkText(d);
    if (text) onText(text);
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
  const [vector] = await embedMany([text], env, config);
  return vector;
}

/** Texts per embedding call. The bge-*-en-v1.5 schemas allow 100 (maxItems, Workers AI docs,
 * checked 2026-09-27); bge-m3 documents no limit, so it gets a conservative 25. */
export function embedBatchSize(model: string): number {
  return /^@cf\/baai\/bge-(small|base|large)-en-v1\.5$/.test(model) ? 100 : 25;
}

/**
 * Embeds every text in `texts`, in order, embedBatchSize(model) per AI call: one call for the few texts
 * standing memory (Track 7) and the single-text wrapper pass, a handful for a long note's chunks (T-0089.1.1). bge-m3
 * gets truncate_inputs (it rejects over-length input otherwise; the bge-en models reject the field; #326
 * spec, 10.6). Throws if a call returns a count that does not match its batch, so a caller never pairs a
 * vector with the wrong text.
 */
export async function embedMany(texts: readonly string[], env: Env, config: Readonly<Config> = DEFAULTS): Promise<number[][]> {
  const size = embedBatchSize(config.EMBEDDING_MODEL);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    const input = config.EMBEDDING_MODEL === "@cf/baai/bge-m3" ? { text: batch, truncate_inputs: true } : { text: batch };
    // Workers AI requires `as any` here — the SDK types don't cover all models
    const result = (await env.AI.run(config.EMBEDDING_MODEL as any, input as any)) as any;
    const data = result?.data as number[][] | undefined;
    if (!Array.isArray(data) || data.length !== batch.length) throw new Error(`embedMany: expected ${batch.length} vectors, got ${data?.length ?? 0}`);
    out.push(...data);
  }
  return out;
}
