/**
 * Contextual chunk embeddings (T-0042).
 *
 * A chunk cut from the middle of a long memory carries none of what the whole
 * memory is about, so a query for the topic never lands on it. Each chunk of a
 * multi-chunk memory is therefore embedded with a short deterministic prefix
 * (first line, project and topic tags, source, date, part number). The prefix
 * is a transient embedding input: entries.content, FTS, and the stored
 * metadata.content stay raw.
 */
import type { Config } from "../config";
import type { Env } from "../env";
import { readStreamText } from "../lib/ai";
import {
  CHUNK_MAX_CHARS,
  CONTEXT_MAX_CONTENT_CHARS,
  CONTEXT_MAX_FOCUS_CHUNKS,
  CONTEXT_M3_TAIL_CHARS,
  CONTEXT_OVERLAP_CHARS,
  CONTEXT_SMALL_TAIL_CHARS,
  CONTEXT_LLM_MAX_TOKENS,
  CONTEXT_M3_BODY_MAX_CHARS,
  CONTEXT_PREFIX_MAX_CHARS,
  CONTEXT_SMALL_BODY_MIN_CHARS,
  CONTEXT_SMALL_BODY_START_CHARS,
  CONTEXT_SMALL_TARGET_TOKENS,
  MIRRORED_SOURCES,
} from "../constants";
import { PROJECT_TAG_PREFIX, isWorkerOwnedTag } from "../tags/system";
import { chunkText, chunkTextLimited } from "../text/chunk";

export type ContextSource = "none" | "deterministic" | "llm";

export interface ContextEntry {
  id: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: number;
}

export interface EmbeddingChunk {
  rawContent: string;
  embeddingText: string;
  chunkIndex: number;
  totalChunks: number;
  contextualized: boolean;
  contextSource: ContextSource;
}

const M3 = "@cf/baai/bge-m3";
const TITLE_MAX_CHARS = 80;
const MAX_PROJECT_TAGS = 2;
const MAX_TOPIC_TAGS = 3;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The first non-empty line up to one sentence, at most TITLE_MAX_CHARS. Reads only the head of the text. */
function title(content: string): string {
  let i = 0;
  while (i < content.length && /\s/.test(content[i])) i++;
  // A title never needs more than a few hundred characters of the first line.
  let end = i;
  const limit = Math.min(content.length, i + 4 * TITLE_MAX_CHARS);
  while (end < limit && content.charCodeAt(end) !== 10) end++;
  const line = squash(content.slice(i, end));
  const sentence = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;
  return sentence.length > TITLE_MAX_CHARS ? `${sentence.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : sentence;
}

const utcDate = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "");

/** What frames every chunk of one entry, worked out once: nothing here depends on the chunk. */
interface Frame {
  title: string;
  projects: string;
  topics: string;
  source: string;
  date: string;
}

function frameOf(entry: ContextEntry): Frame {
  const projects: string[] = [];
  const topics: string[] = [];
  for (const t of entry.tags) {
    if (t.toLowerCase().startsWith(PROJECT_TAG_PREFIX)) {
      if (projects.length < MAX_PROJECT_TAGS) projects.push(t.slice(PROJECT_TAG_PREFIX.length));
    } else if (topics.length < MAX_TOPIC_TAGS && !isWorkerOwnedTag(t)) {
      topics.push(t);
    }
  }
  return {
    title: title(entry.content).replace(/[.!?\u2026]+$/, ""),
    projects: projects.join(", "),
    topics: topics.join(", "),
    source: entry.source,
    date: utcDate(entry.createdAt),
  };
}

/**
 * The framing sentence for one chunk. Lower `detail` keeps more: the title and
 * tags go first when the prefix has to fit a token budget, the part number never.
 */
function framing(f: Frame, chunkIndex: number, totalChunks: number, detail: 0 | 1 | 2): string {
  const bits: string[] = [];
  if (detail < 2 && f.title) bits.push(f.title);
  if (detail < 2 && f.projects) bits.push(`Project ${f.projects}`);
  if (detail < 1 && f.topics) bits.push(`Topics ${f.topics}`);
  if (detail < 2 && f.source) bits.push(`Source ${f.source}`);
  if (detail < 2 && f.date) bits.push(`Saved ${f.date}`);
  bits.push(`Part ${chunkIndex + 1} of ${totalChunks}`);
  return squash(`[Memory: ${bits.join(". ")}.]`);
}

/** `[Memory: ...]` for one chunk, at most CONTEXT_PREFIX_MAX_CHARS. Deterministic in its arguments. */
export function buildDeterministicContext(entry: ContextEntry, chunkIndex: number, totalChunks: number): string {
  const f = frameOf(entry);
  for (const detail of [0, 1, 2] as const) {
    const p = framing(f, chunkIndex, totalChunks, detail);
    if (p.length <= CONTEXT_PREFIX_MAX_CHARS) return p;
  }
  return framing(f, chunkIndex, totalChunks, 2).slice(0, CONTEXT_PREFIX_MAX_CHARS);
}

const ALNUM = /[\p{L}\p{N}]/u;

/**
 * Upper-bounds the BERT WordPiece token count of `text`, special tokens
 * included. CJK code points and punctuation cost one token each. An
 * alphanumeric run costs one token per character when it mixes in digits or
 * runs past 12 characters (hex ids, UUIDs, base64, long identifiers tokenize at
 * about 1 to 1.4 characters per token), one per two characters from 7 to 12
 * letters, and one per three up to 6. Biased high so a contextualized input
 * does not depend on the embedder truncating its tail.
 *
 * The margin against the 512-token window is not this function's slack alone:
 * a fitted chunk is never shorter than CONTEXT_SMALL_BODY_MIN_CHARS, and even
 * at one token per character that body plus a capped prefix stays under the
 * window. A run of random short letters can still beat the per-run rule, which
 * is no worse than the plain 1,600-character chunks already sent.
 *
 * One pass, ASCII decided by character code and only other characters by
 * regex, because this runs over every character of a long note on the write path.
 */
export function estimateBgeSmallTokens(text: string): number {
  let tokens = 2;
  let run = 0;
  let digit = false;
  const flush = () => {
    if (run) tokens += digit || run > 12 ? run : run > 6 ? Math.ceil(run / 2) : Math.ceil(run / 3);
    run = 0;
    digit = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      if (c >= 97 && c <= 122 || c >= 65 && c <= 90) run++;
      else if (c >= 48 && c <= 57) { run++; digit = true; }
      else {
        flush();
        if (c !== 32 && c !== 10 && c !== 9 && c !== 13 && c !== 11 && c !== 12) tokens++;
      }
      continue;
    }
    if (c >= 0x2e80 && c <= 0x9fff || c >= 0xac00 && c <= 0xd7af || c >= 0xf900 && c <= 0xfaff) { flush(); tokens++; continue; }
    // Astral characters are two UTF-16 units; classify the pair once.
    const ch = c >= 0xd800 && c <= 0xdbff ? String.fromCodePoint(text.codePointAt(i)!) : String.fromCharCode(c);
    if (ch.length === 2) i++;
    if (ALNUM.test(ch)) {
      run += ch.length;
      if (/\p{N}/u.test(ch)) digit = true;
    } else { flush(); if (!/\s/u.test(ch)) tokens++; }
  }
  flush();
  return tokens;
}

/** Today's chunks, unprefixed: what every entry got before contextual embeddings, and the fallback when building context fails. */
export function plainEmbeddingChunks(entry: Pick<ContextEntry, "content" | "source">): EmbeddingChunk[] {
  const all = chunkText(entry.content);
  const chunks = MIRRORED_SOURCES.has(entry.source) ? all.slice(0, 1) : all;
  return chunks.map((c, i) => ({
    rawContent: c, embeddingText: c, chunkIndex: i, totalChunks: chunks.length, contextualized: false, contextSource: "none",
  }));
}

/** True when this entry gets contextual vectors: more than one effective chunk, no more than CONTEXT_MAX_CONTENT_CHARS, and not a mirrored record (first chunk only). */
export function isContextEligible(entry: Pick<ContextEntry, "content" | "source">): boolean {
  return !MIRRORED_SOURCES.has(entry.source)
    && entry.content.length > CHUNK_MAX_CHARS && entry.content.length <= CONTEXT_MAX_CONTENT_CHARS
    && chunkText(entry.content).length > 1;
}

/** The chunks to embed for `entry`, in order. Single-chunk and mirrored entries come back plain, byte for byte. */
export function buildEmbeddingChunks(
  entry: ContextEntry,
  config: Readonly<Config>,
  llmContexts?: readonly string[],
  /** False cuts the whole note at the tail size: focus chunks are a budget (see focus-budget.ts). Default true. */
  focus = true,
): EmbeddingChunk[] {
  if (config.CONTEXTUAL_EMBEDDINGS !== "on" || !isContextEligible(entry)) return plainEmbeddingChunks(entry);

  const m3 = config.EMBEDDING_MODEL === M3;
  const frame = frameOf(entry);
  const prefixFor = (i: number, n: number, detail: 0 | 1 | 2): string =>
    llmContexts?.length === n && llmContexts[i] ? `[Memory: ${squash(llmContexts[i])}]` : framing(frame, i, n, detail);
  const contextSource: ContextSource = llmContexts ? "llm" : "deterministic";

  let raw: string[];
  // A part number of at most two digits, worst case, so the prefix's cost is one number for every chunk.
  const worstPrefixTokens = m3 ? 0 : estimateBgeSmallTokens(prefixFor(0, 99, 0)) - 2 + 1;
  if (m3) {
    // bge-m3's window is far larger than any chunk, so no fitting.
    raw = cutHybrid(entry.content, focus ? CONTEXT_M3_BODY_MAX_CHARS : CONTEXT_M3_TAIL_CHARS, CONTEXT_M3_TAIL_CHARS);
  } else {
    // Shrink the bodies uniformly until the worst prefixed chunk fits; the whole text stays covered by extra chunks.
    let head = focus ? CONTEXT_SMALL_BODY_START_CHARS : CONTEXT_SMALL_TAIL_CHARS;
    let tail = CONTEXT_SMALL_TAIL_CHARS;
    for (;;) {
      raw = cutHybrid(entry.content, head, tail);
      let worst = 0;
      for (const c of raw) worst = Math.max(worst, estimateBgeSmallTokens(c) - 2);
      if (worst + worstPrefixTokens + 2 <= CONTEXT_SMALL_TARGET_TOKENS || (head <= CONTEXT_SMALL_BODY_MIN_CHARS && tail <= CONTEXT_SMALL_BODY_MIN_CHARS)) break;
      // Scale by how far over the worst chunk was, with a little to spare, so dense text settles in one or two cuts.
      const shrink = Math.min(0.8, ((CONTEXT_SMALL_TARGET_TOKENS - worstPrefixTokens - 2) / worst) * 0.95);
      head = Math.max(CONTEXT_SMALL_BODY_MIN_CHARS, Math.floor(head * shrink));
      tail = Math.max(CONTEXT_SMALL_BODY_MIN_CHARS, Math.floor(tail * shrink));
    }
  }

  const n = raw.length;
  return raw.map((c, i) => {
    // Under BGE Small, fall through to a shorter prefix rather than exceed the budget.
    let prefix = prefixFor(i, n, 0);
    if (!m3) {
      const bodyTokens = estimateBgeSmallTokens(c) - 2;
      for (const detail of [1, 2] as const) {
        if (estimateBgeSmallTokens(prefix) + bodyTokens <= CONTEXT_SMALL_TARGET_TOKENS) break;
        prefix = prefixFor(i, n, detail);
      }
    }
    return {
      rawContent: c, embeddingText: `${prefix}\n${c}`, chunkIndex: i, totalChunks: n, contextualized: true, contextSource,
    };
  });
}

/** Focus chunks for the head of the note, then `tail`-sized chunks for the rest: at most CONTEXT_MAX_FOCUS_CHUNKS small vectors per note. */
function cutHybrid(content: string, focus: number, tail: number): string[] {
  const head = chunkTextLimited(content, focus, CONTEXT_OVERLAP_CHARS, CONTEXT_MAX_FOCUS_CHUNKS);
  if (head.restStart === null) return head.chunks;
  return [...head.chunks, ...chunkText(content.slice(head.restStart), tail, CONTEXT_OVERLAP_CHARS)];
}

const LLM_ENTRY_CHARS = 800;

/** One plain sentence, one line, no markup, and not the prompt read back. Null means unusable. */
export function cleanGeneratedContext(raw: string): string | null {
  const line = squash(raw.replace(/^["'\s]+|["'\s]+$/g, ""));
  if (!line || line.length > CONTEXT_PREFIX_MAX_CHARS - "[Memory: ]".length) return null;
  if (/[`*#<>\[\]{}]|^(here|sure|this chunk|the chunk)\b/i.test(line) || /situate|chunk of|memory:/i.test(line)) return null;
  return line;
}

/**
 * One model-written sentence that situates `chunk` within its entry, or null on
 * any failure (call error, empty or unusable output). Never throws: the
 * caller keeps the deterministic prefix when this returns null.
 */
export async function generateChunkContext(
  entry: ContextEntry,
  chunk: string,
  chunkIndex: number,
  totalChunks: number,
  env: Env,
  config: Readonly<Config>,
): Promise<string | null> {
  try {
    const stream = await env.AI.run(config.CONTEXTUAL_EMBEDDING_LLM_MODEL as any, {
      messages: [{ role: "user", content:
        `Write ONE plain sentence, at most 25 words, that says what part of the whole memory this chunk covers, so the chunk can be found by what the memory is about. ` +
        `Use only facts present below. No markdown, no quotes, no preamble.\n\n` +
        `Whole memory (start): ${entry.content.slice(0, LLM_ENTRY_CHARS)}\n\n` +
        `Chunk ${chunkIndex + 1} of ${totalChunks}: ${chunk}` }],
      max_tokens: CONTEXT_LLM_MAX_TOKENS,
      temperature: 0,
      stream: true,
    });
    return cleanGeneratedContext(await readStreamText(stream as ReadableStream));
  } catch {
    return null;
  }
}

/**
 * The text a stored vector of this note's first chunk was embedded from, for a
 * caller that wants to compare new content against what capture stored (the
 * duplicate check). Null when the note is not contextualized, so the caller
 * compares against plain chunks as before.
 */
export function firstChunkEmbeddingText(
  entry: Pick<ContextEntry, "content" | "source"> & Partial<ContextEntry>,
  config: Readonly<Config>,
  focus = true,
): string | null {
  const chunks = buildEmbeddingChunks({ id: "", tags: [], createdAt: Date.now(), ...entry } as ContextEntry, config, undefined, focus);
  return chunks[0]?.contextualized ? chunks[0].embeddingText : null;
}
