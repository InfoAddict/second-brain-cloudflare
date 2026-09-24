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
import {
  CHUNK_OVERLAP_CHARS,
  CONTEXT_M3_BODY_MAX_CHARS,
  CONTEXT_PREFIX_MAX_CHARS,
  CONTEXT_SMALL_BODY_MIN_CHARS,
  CONTEXT_SMALL_BODY_START_CHARS,
  CONTEXT_SMALL_TARGET_TOKENS,
  MIRRORED_SOURCES,
} from "../constants";
import { PROJECT_TAG_PREFIX, isWorkerOwnedTag } from "../tags/system";
import { chunkText } from "../text/chunk";

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

function title(content: string): string {
  const line = content.split("\n").map(squash).find(l => l.length > 0) ?? "";
  const sentence = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;
  return sentence.length > TITLE_MAX_CHARS ? `${sentence.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : sentence;
}

const utcDate = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "");

/**
 * The framing sentence for one chunk. `parts` is what may be shortened when the
 * prefix has to fit a token budget: the title and tags go first, the part
 * number never does.
 */
function framing(entry: ContextEntry, chunkIndex: number, totalChunks: number, detail: 0 | 1 | 2): string {
  const projects = entry.tags
    .filter(t => t.toLowerCase().startsWith(PROJECT_TAG_PREFIX))
    .map(t => t.slice(PROJECT_TAG_PREFIX.length))
    .slice(0, MAX_PROJECT_TAGS);
  const topics = entry.tags
    .filter(t => !isWorkerOwnedTag(t) && !t.toLowerCase().startsWith(PROJECT_TAG_PREFIX))
    .slice(0, MAX_TOPIC_TAGS);
  const t = title(entry.content);
  const date = utcDate(entry.createdAt);
  const bits: string[] = [];
  if (t) bits.push(detail === 2 ? "" : t.replace(/[.!?…]+$/, ""));
  if (detail < 2 && projects.length) bits.push(`Project ${projects.join(", ")}`);
  if (detail < 1 && topics.length) bits.push(`Topics ${topics.join(", ")}`);
  if (detail < 2 && entry.source) bits.push(`Source ${entry.source}`);
  if (detail < 2 && date) bits.push(`Saved ${date}`);
  bits.push(`Part ${chunkIndex + 1} of ${totalChunks}`);
  return squash(`[Memory: ${bits.filter(Boolean).join(". ")}.]`);
}

/** `[Memory: ...]` for one chunk, at most CONTEXT_PREFIX_MAX_CHARS. Deterministic in its arguments. */
export function buildDeterministicContext(entry: ContextEntry, chunkIndex: number, totalChunks: number): string {
  for (const detail of [0, 1, 2] as const) {
    const p = framing(entry, chunkIndex, totalChunks, detail);
    if (p.length <= CONTEXT_PREFIX_MAX_CHARS) return p;
  }
  return framing(entry, chunkIndex, totalChunks, 2).slice(0, CONTEXT_PREFIX_MAX_CHARS);
}

const CJK = /[⺀-鿿가-힯豈-﫿぀-ヿ]/u;

/**
 * Upper-bounds the BERT WordPiece token count of `text`, special tokens
 * included. CJK code points and punctuation cost one token each. An
 * alphanumeric run costs one token per character when it mixes in digits or
 * runs past 12 characters (hex ids, UUIDs, base64, long identifiers tokenize at
 * about 1 to 1.4 characters per token), one per two characters from 7 to 12
 * letters, and one per three up to 6. Biased high so a contextualized input
 * does not depend on the embedder truncating its tail; a run of random short
 * letters can still beat it, which is no worse than the plain 1,600-character
 * chunks already sent.
 */
export function estimateBgeSmallTokens(text: string): number {
  let tokens = 2;
  let run = "";
  const flush = () => {
    const len = run.length;
    if (len) tokens += /\d/.test(run) || len > 12 ? len : len > 6 ? Math.ceil(len / 2) : Math.ceil(len / 3);
    run = "";
  };
  for (const ch of text) {
    if (CJK.test(ch)) { flush(); tokens += 1; }
    else if (/[\p{L}\p{N}]/u.test(ch)) run += ch;
    else { flush(); if (!/\s/.test(ch)) tokens += 1; }
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

/** True when this entry gets contextual vectors: more than one effective chunk, and not a mirrored record (first chunk only). */
export function isContextEligible(entry: Pick<ContextEntry, "content" | "source">): boolean {
  return !MIRRORED_SOURCES.has(entry.source) && chunkText(entry.content).length > 1;
}

/** The chunks to embed for `entry`, in order. Single-chunk and mirrored entries come back plain, byte for byte. */
export function buildEmbeddingChunks(
  entry: ContextEntry,
  config: Readonly<Config>,
  llmContexts?: readonly string[],
): EmbeddingChunk[] {
  if (config.CONTEXTUAL_EMBEDDINGS !== "on" || !isContextEligible(entry)) return plainEmbeddingChunks(entry);

  let raw: string[];
  const prefixFor = (i: number, n: number, detail: 0 | 1 | 2): string =>
    llmContexts?.length === n && llmContexts[i] ? `[Memory: ${squash(llmContexts[i])}]` : framing(entry, i, n, detail);
  const contextSource: ContextSource = llmContexts ? "llm" : "deterministic";

  if (config.EMBEDDING_MODEL === M3) {
    // bge-m3's window is far larger than any chunk, so no fitting.
    raw = chunkText(entry.content, CONTEXT_M3_BODY_MAX_CHARS, CHUNK_OVERLAP_CHARS);
  } else {
    // Shrink the body uniformly until the worst prefixed chunk fits; the whole text stays covered by extra chunks.
    let body = CONTEXT_SMALL_BODY_START_CHARS;
    for (;;) {
      raw = chunkText(entry.content, body, CHUNK_OVERLAP_CHARS);
      const n = raw.length;
      const worst = Math.max(...raw.map((c, i) => estimateBgeSmallTokens(`${prefixFor(i, Math.max(n, 99), 0)}\n${c}`)));
      if (worst <= CONTEXT_SMALL_TARGET_TOKENS || body <= CONTEXT_SMALL_BODY_MIN_CHARS) break;
      body = Math.max(CONTEXT_SMALL_BODY_MIN_CHARS, Math.floor(body * 0.8));
    }
  }

  const n = raw.length;
  return raw.map((c, i) => {
    // Under BGE Small, fall through to a shorter prefix rather than exceed the budget.
    let prefix = prefixFor(i, n, 0);
    if (config.EMBEDDING_MODEL !== M3) {
      for (const detail of [1, 2] as const) {
        if (estimateBgeSmallTokens(`${prefix}\n${c}`) <= CONTEXT_SMALL_TARGET_TOKENS) break;
        prefix = prefixFor(i, n, detail);
      }
    }
    return {
      rawContent: c, embeddingText: `${prefix}\n${c}`, chunkIndex: i, totalChunks: n, contextualized: true, contextSource,
    };
  });
}
