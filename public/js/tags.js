// Which tags are the brain's own bookkeeping, and which are the user's.
//
// The Worker writes tags in reserved namespaces (kind:, status:, volatility:,
// stale:) and a handful of machinery markers, and until v2.3 every one of them
// rendered as a chip alongside the tags a person actually chose. On a real brain
// that put `kind:episodic` at the top of "most used tags" and buried human tags
// under bookkeeping on every row.
//
// These stay visible in exactly one place — the memory detail view, labelled as
// what they are. Everywhere else the answer to "what is this memory about?"
// should be the user's own words.

/** Namespaces the Worker owns. Anything `prefix:value` shaped and reserved. */
const SYSTEM_TAG_PREFIXES = ['kind:', 'status:', 'volatility:', 'stale:']

/** Bare markers the pipeline writes: compression, pattern mining, dedupe. */
const SYSTEM_TAG_NAMES = new Set(['auto-pattern', 'synthesized', 'rolled-up', 'duplicate-candidate'])

/**
 * Is this tag the brain talking to itself?
 *
 * Pure-numeric tags count too. They are not a namespace but a capture artifact:
 * a GitHub PR body full of `#5118` issue references arrives as twenty numeric
 * "tags". v2.3 stops extracting those (src/text/hashtags.ts), but rows captured
 * before that fix keep theirs, and no backfill is worth rewriting history for.
 * Hiding them here cleans up the past without touching stored data.
 */
function isSystemTag(tag) {
  if (typeof tag !== 'string') return true
  const t = tag.trim().toLowerCase()
  if (!t) return true
  if (SYSTEM_TAG_NAMES.has(t)) return true
  if (/^\d+$/.test(t)) return true
  return SYSTEM_TAG_PREFIXES.some((p) => t.startsWith(p))
}

/** The tags worth showing a person, in their original order. */
function humanTags(tags) {
  return (Array.isArray(tags) ? tags : []).filter((t) => !isSystemTag(t))
}
