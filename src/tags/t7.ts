// Track 7 (standing memory, decision ledger, two-way commitments) reserved
// tag namespaces, registered once here so the four lists that police
// reserved tags -- this file's consumer in src/tags/system.ts,
// src/compression/eligibility.ts, public/utils.js and src/projects/registry.ts
// -- spread the same constants instead of each keeping its own copy. See
// test/unit/reserved-tags-parity.test.ts for the guard that fails if they drift.
//
// standing and decision are deliberately NOT reserved as bare words: both are
// common ordinary tags in real brains (P7.2), and reserving them would turn
// every pre-existing decision-tagged or standing-tagged memory into a locked
// ledger/standing row on upgrade -- a backfill by reinterpretation. The active
// markers are the namespaced standing:active and ledger:decision instead.

export const STANDING_TAG_PREFIX = "standing:";
export const LEDGER_TAG_PREFIX = "ledger:";
export const CONFIDENCE_TAG_PREFIX = "confidence:";
export const CONFIDENCE_SOURCE_TAG_PREFIX = "confidence-source:";
export const OUTCOME_TAG_PREFIX = "outcome:";
export const REVIEW_REARMS_TAG_PREFIX = "review-rearms:";
export const COUNTERPARTY_TAG_PREFIX = "counterparty:";

/** The inbound-commitment marker: a bare word, not a namespace (P7.3). */
export const OWED_TO_ME_TAG = "owed-to-me";

/** The two active markers a typed capture sets; see the module comment. */
export const STANDING_TAG = `${STANDING_TAG_PREFIX}active`;
export const LEDGER_TAG = `${LEDGER_TAG_PREFIX}decision`;

/** Every Track 7 prefix, spread into the four reserved-tag lists. */
export const T7_TAG_PREFIXES = [
  STANDING_TAG_PREFIX,
  LEDGER_TAG_PREFIX,
  CONFIDENCE_TAG_PREFIX,
  CONFIDENCE_SOURCE_TAG_PREFIX,
  OUTCOME_TAG_PREFIX,
  REVIEW_REARMS_TAG_PREFIX,
  COUNTERPARTY_TAG_PREFIX,
] as const;

/** Every Track 7 bare marker name. */
export const T7_TAG_NAMES = new Set<string>([OWED_TO_ME_TAG]);

/**
 * Drops any caller-supplied Track 7 tag from a tag list, so a raw `remember`
 * or `update` tag can never forge a namespace that only the typed parameters
 * (`standing`, `decision`, `confidence`, `owed_by`, `owed_to`, ...) may set.
 *
 * Pure and unwired in this commit: the capture and update call sites that use
 * this to strip and report ignored tags are a later task. This registration
 * commit only reserves the namespaces and proves the helper's own contract.
 */
export function stripT7CallerTags(tags: readonly string[]): { kept: string[]; ignored: string[] } {
  const kept: string[] = [];
  const ignored: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const t = tag.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    const isT7 = T7_TAG_NAMES.has(lower) || T7_TAG_PREFIXES.some(p => lower.startsWith(p));
    (isT7 ? ignored : kept).push(t);
  }
  return { kept, ignored };
}
