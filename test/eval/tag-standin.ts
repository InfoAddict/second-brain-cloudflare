/*
 * Deterministic stand-in for the inferQueryTags LLM call (src/recall/distill.ts) in the replay layer.
 * It reads the tags the prompt shows and the query, and returns the shown tags whose bge-small embedding is
 * near the query's. Agreement with the real model (llama-4-scout) is unmeasured.
 */

/** Best tags kept per query; matches the T-0079 candidate (cap 2-3). */
export const STAND_IN_MAX_TAGS = 3;

/** Model the stand-in embeds with, whatever model the corpus runs under. */
export const STAND_IN_EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

/**
 * Cosine floor for a tag to count as matching. Set from the label-free noise distribution, not from gold tags:
 * over every (query, shown tag) pair of the core-1k baseline (310 LLM-bound queries x 38 tags, bare tag text,
 * bge-small) cosine has mean 0.461 and sd 0.055, so mean + 2 sd = 0.571, rounded to 0.57. A tag clears it only if
 * it is a ~2-sigma outlier for its query, about the top 4% of pairs, which keeps the expected count near the cap.
 * Measured against gold (tags on the needles a query is graded against): see the T-0079 report; the signal is weak.
 */
export const STAND_IN_TAG_THRESHOLD = 0.57;

const HEAD = "From this list of tags: ";
const MID = "\n\nWhich tags best match this query? Reply with only a comma-separated list of matching tag names from the list, or nothing if none apply.\n\nQuery: ";

const drift = (why: string): never => {
  throw new Error(`the LLM prompt is not the inferQueryTags prompt (${why}); update PROMPT parsing in test/eval/tag-standin.ts to match src/recall/distill.ts`);
};

/**
 * Strict on the template: any deviation from distill.ts's wording throws instead of guessing.
 *
 * The list is split the way production splits a reply (on commas, trimmed, empties dropped, repeats folded).
 * Stored tags may contain commas (capture only trims and lowercases; validInputTags bounds length and NUL), so
 * "a, b" is shown as two words and a reply can never name it. Mirroring the split keeps every tag the stand-in
 * returns an exact piece of what production will split, so production's own known-tag filter decides what survives.
 */
export function parseTagPrompt(input: { messages?: { role?: string; content?: string }[]; [other: string]: unknown }): { tags: string[]; query: string } {
  const msgs = input.messages;
  if (!Array.isArray(msgs) || msgs.length !== 1 || msgs[0].role !== "user" || typeof msgs[0].content !== "string") {
    throw new Error("expected exactly one user message in the inferQueryTags prompt");
  }
  const content = msgs[0].content;
  if (!content.startsWith(HEAD)) return drift("head");
  const midAt = content.indexOf(MID, HEAD.length);
  if (midAt < 0) return drift("instruction");
  const tags = [...new Set(content.slice(HEAD.length, midAt).split(",").map(t => t.trim()).filter(Boolean))];
  if (!tags.length) throw new Error("empty tag list in the inferQueryTags prompt; production never calls the model without tags");
  return { tags, query: content.slice(midAt + MID.length) };
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Tags at or above the threshold, best cosine first (ties by name), at most `cap`. */
export function pickTags(query: readonly number[], tags: readonly string[], vectors: ReadonlyMap<string, readonly number[]>, threshold: number, cap: number): string[] {
  return tags
    .map(tag => {
      const v = vectors.get(tag);
      if (!v) throw new Error(`no embedding for tag "${tag}"`);
      return { tag, score: cosine(query, v) };
    })
    .filter(t => t.score >= threshold)
    .sort((a, b) => b.score - a.score || (a.tag < b.tag ? -1 : 1))
    .slice(0, cap)
    .map(t => t.tag);
}

/** The reply shape inferQueryTags parses: comma-separated tag names, or nothing. */
export const formatTags = (tags: readonly string[]): string => tags.join(", ");
