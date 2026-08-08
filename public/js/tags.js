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
 * Machine identifiers that a `#token` scan mistook for tags: `#5118` issue
 * references, `#fd540a` colour codes, `#0f3d3e` short commit SHAs. The tag
 * filter on a real brain was pages of these before anything readable.
 *
 * The hex rule is deliberately narrow, because plenty of real tags look
 * numeric at a glance:
 *   - a digit is required, so `facade`, `decade` and `added` stay tags;
 *   - six characters minimum, so `d1` (Cloudflare D1) and `v2` stay tags;
 *   - the whole string must be hex, so `12v-battery` and `14-day-plan` stay.
 */
function isMachineIdentifier(t) {
  if (/^\d+$/.test(t)) return true
  return /^[0-9a-f]{6,40}$/.test(t) && /\d/.test(t)
}

/**
 * Is this tag the brain talking to itself?
 *
 * v2.3 stops extracting these at capture (src/text/hashtags.ts), but rows
 * written before that keep theirs, and no backfill is worth rewriting history
 * for. Hiding them cleans up the past without touching stored data.
 */
function isSystemTag(tag) {
  if (typeof tag !== 'string') return true
  const t = tag.trim().toLowerCase()
  if (!t) return true
  if (SYSTEM_TAG_NAMES.has(t)) return true
  if (isMachineIdentifier(t)) return true
  return SYSTEM_TAG_PREFIXES.some((p) => t.startsWith(p))
}

/** The tags worth showing a person, in their original order. */
function humanTags(tags) {
  return (Array.isArray(tags) ? tags : []).filter((t) => !isSystemTag(t))
}
