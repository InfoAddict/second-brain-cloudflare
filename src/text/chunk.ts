import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS } from "../constants";

/**
 * Cuts `text` into at most `limit` chunks (all of them when omitted) and
 * reports where the uncut rest begins, or null when nothing is left.
 *
 * A chunk ends at the last sentence period or newline in the back half of its
 * window, else at the window. The search walks back from the window's end and
 * stops at the half-way point, so a run with no period or newline costs one
 * window per chunk rather than a scan back to the start of the text.
 */
export function chunkTextLimited(text: string, maxChars: number, overlapChars: number, limit = Infinity): { chunks: string[]; restStart: number | null } {
  if (text.length <= maxChars) return { chunks: [text], restStart: null };

  const chunks: string[] = [];
  const half = maxChars / 2;
  let start = 0;

  while (start < text.length) {
    if (chunks.length >= limit) return { chunks, restStart: start };
    let end = start + maxChars;
    if (end < text.length) {
      for (let i = end; i > start + half; i--) {
        const c = text.charCodeAt(i);
        if (c === 46 || c === 10) { end = i + 1; break; }
      }
    }
    const chunk = text.slice(start, Math.min(end, text.length)).trim();
    if (chunk.length > 0) chunks.push(chunk);
    start = end - overlapChars;
  }

  return { chunks, restStart: null };
}

export function chunkText(text: string, maxChars = CHUNK_MAX_CHARS, overlapChars = CHUNK_OVERLAP_CHARS): string[] {
  return chunkTextLimited(text, maxChars, overlapChars).chunks;
}
