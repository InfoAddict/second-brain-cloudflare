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

// Same slug grammar as PROJECT_SLUG_RE (src/tags/system.ts). Duplicated rather
// than imported: system.ts imports from this file, so importing back would be
// circular. public/utils.js already duplicates the same grammar for the same
// reason (see its PROJECT_SLUG_RE comment).
const T7_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Exact string set rather than a numeric range check: floating-point steps
// (0.05, 0.10, ...) do not divide evenly in binary, so comparing parsed
// numbers risks the same class of bug the design note on isTopicTagSql warns
// about for LIKE wildcards -- an off-by-a-rounding-error match. Nineteen
// fixed strings has no such risk.
const CONFIDENCE_VALUES = new Set([
  "0.05", "0.10", "0.15", "0.20", "0.25", "0.30", "0.35", "0.40", "0.45",
  "0.50", "0.55", "0.60", "0.65", "0.70", "0.75", "0.80", "0.85", "0.90", "0.95",
]);

/** True when a bare value (no prefix) is standing:active's one legal value. */
export function isStandingValue(value: string): boolean {
  return value === "active";
}

/** True when a bare value (no prefix) is ledger:decision's one legal value. */
export function isLedgerValue(value: string): boolean {
  return value === "decision";
}

/** True when a bare value (no prefix) is a two-decimal confidence in [0.05, 0.95], step 0.05. */
export function isConfidenceValue(value: string): boolean {
  return CONFIDENCE_VALUES.has(value);
}

/** True when a bare value (no prefix) is a recognized confidence source. */
export function isConfidenceSourceValue(value: string): boolean {
  return value === "stated" || value === "inferred";
}

/** True when a bare value (no prefix) is a recognized decision outcome. */
export function isOutcomeValue(value: string): boolean {
  return value === "right" || value === "wrong" || value === "mixed" || value === "unknown";
}

/** True when a bare value (no prefix) is a recognized review-rearm count. */
export function isReviewRearmsValue(value: string): boolean {
  return value === "1" || value === "2";
}

/** True when a bare value (no prefix) is a valid counterparty slug. */
export function isCounterpartyValue(value: string): boolean {
  return T7_SLUG_RE.test(value);
}

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
