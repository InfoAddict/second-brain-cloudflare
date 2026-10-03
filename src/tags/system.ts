// Which tags belong to the brain, and which belong to the person.
//
// The distinction only becomes load-bearing when something *replaces* a
// memory's tags rather than adding to them. Until the editor grew a remove
// control, every write path unioned the new tags onto the old ones, so nothing
// could ever be lost and nothing had to be protected. A replacement can lose
// things, and the things it must not lose are the ones the Worker wrote for
// itself: the classifier's `kind:`, the contradiction pass's `status:`, the
// staleness pass's `volatility:` and `stale:`, and the pipeline's own markers.
// Those are conclusions the brain reached, not labels the user typed, and they
// are not the editor's to delete.
//
// public/utils.js draws the same line for display and for graph clustering, and
// additionally hides machine identifiers (`#5118`, `#fd540a`). That extra rule is
// deliberately absent here: hiding a junk tag costs nothing, but treating it as
// unowned would let an edit silently delete a tag that is genuinely stored.
import { QUARANTINE_TAG_PREFIX, EDITED_CANONICAL_TAG_PREFIX, isHoldReasonValue, isEditedCanonicalDateValue } from "../quarantine/tags";
import {
  T7_TAG_PREFIXES, OWED_TO_ME_TAG,
  STANDING_TAG_PREFIX, LEDGER_TAG_PREFIX, CONFIDENCE_TAG_PREFIX, CONFIDENCE_SOURCE_TAG_PREFIX,
  OUTCOME_TAG_PREFIX, REVIEW_REARMS_TAG_PREFIX, COUNTERPARTY_TAG_PREFIX,
  isStandingValue, isLedgerValue, isConfidenceValue, isConfidenceSourceValue,
  isOutcomeValue, isReviewRearmsValue, isCounterpartyValue,
} from "./t7";

/** Prompt Capsule bookkeeping prefixes shared by selection and pipeline guards. */
export const CAPSULE_TAG_PREFIX = "capsule:";
export const CAPSULE_SLOT_TAG_PREFIX = "capsule-slot:";

/**
 * Project membership. A display/topic namespace, deliberately NOT in RESERVED_TAG_PREFIXES
 * below: users and agents add and remove it through ordinary tag replacement.
 */
export const PROJECT_TAG_PREFIX = "project:";
/** Slug grammar shared by the registry, project tags, and the capsule project id. */
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Marks a digest or insight a person has edited. Keep in step with public/utils.js. */
export const USER_EDITED_TAG = "user-edited";

/**
 * Marks a digest or insight a system job stored as a draft because it contradicted a row it may not
 * rewrite. It stays a held draft: no later system job supersedes, merges into or replaces it, and
 * no source is rolled up onto it. Keep in step with public/utils.js.
 */
export const CONFLICT_HELD_TAG = "conflict-held";
/** A memory built on one that was later retracted (T-0089.2.4): flagged for a check, never blocked. */
export const RETRACTED_SOURCE_TAG = "retracted-source";

/** Tags that make a row a system job's output, by job. */
export const SYSTEM_JOB_TAGS = { digest: "synthesized", insight: "auto-insight" } as const;

/**
 * The tags to write when a person edits a row's content: a system-written row gains
 * `user-edited` in the SAME statement as the edit, so no window exists in which the
 * edited row still reads as the system's to overwrite. Any other row is unchanged.
 */
export function withUserEditMarker(tags: string[]): string[] {
  const systemWritten = Object.values(SYSTEM_JOB_TAGS).some(t => tags.includes(t));
  return systemWritten && !tags.includes(USER_EDITED_TAG) ? [...tags, USER_EDITED_TAG] : tags;
}

/** Namespaces the Worker writes and owns; `prefix:value` shaped. */
export const RESERVED_TAG_PREFIXES = [
  "kind:",
  "status:",
  "volatility:",
  "stale:",
  CAPSULE_TAG_PREFIX,
  CAPSULE_SLOT_TAG_PREFIX,
  QUARANTINE_TAG_PREFIX,
  EDITED_CANONICAL_TAG_PREFIX,
  ...T7_TAG_PREFIXES,
];

/**
 * The pre-4.0 subset of RESERVED_TAG_PREFIXES: prefix-only on purpose, unlike the namespaces
 * this contract added below. This is the "separate, pre-existing gap" isNewReservedTag's own
 * comment describes -- a caller-supplied kind:/status:/capsule: tag is neither stripped nor
 * rejected on capture or replacement, so there is no write-time guard here to keep in step with
 * isRecognizedReservedTagFormat the way isNewReservedTag now is. Unchanged by T-0102.
 */
const OLD_RESERVED_PREFIXES = ["kind:", "status:", "volatility:", "stale:", CAPSULE_TAG_PREFIX, CAPSULE_SLOT_TAG_PREFIX];

/**
 * Bare markers the Worker writes: compression, pattern mining, dedupe, and the
 * contradiction pass. Keep in step with SYSTEM_TAG_NAMES in public/utils.js.
 *
 * `contradiction-resolved` is written by captureEntry (src/capture/entry.ts) the
 * moment a contradiction is detected, exactly like the rest of these — but it was
 * missing from both this list and the display one, so it rendered as a tag the user
 * had chosen and an edit could delete it.
 */
const PIPELINE_TAG_NAMES = new Set([
  "auto-pattern",
  "auto-insight",
  "synthesized",
  "rolled-up",
  "duplicate-candidate",
  "contradiction-resolved",
  // A person edited a system-written row (digest or insight). From then on it is theirs,
  // and no system job may merge into or replace it. See markUserEdited.
  USER_EDITED_TAG,
  CONFLICT_HELD_TAG,
  // The inbound-commitment marker (Track 7); a bare word, not a namespace (P7.3).
  OWED_TO_ME_TAG,
  // Built on a memory that was later retracted (Track 2 cascade, T-0089.2.4). Cleared by undo or Keep.
  RETRACTED_SOURCE_TAG,
]);

/**
 * The one normalization every caller-, import- or sync-supplied tag list must pass through
 * before it is ever written (Codex review class B, T-0089.4.2): trims each tag and drops any
 * that become empty. A stored tag with a leading or trailing space still matches
 * `isWorkerOwnedTag`/`isHeld` (both trim before checking), but never matches the literal LIKE
 * patterns (NOT_HELD_SQL, INDEXABLE_SQL) those same tags drive at the SQL layer — a held row
 * with a stray space around its `quarantine:` tag would then read as excluded in application
 * code but still surface through a raw SQL filter. Applied at every entry point tags can first
 * reach storage from outside this Worker's own write paths (capture already trims via
 * normalizeCaptureInput; this covers the ones that do not): import, trash restore, and mirror
 * sync. Idempotent, so calling it more than once on the same list is harmless.
 */
export function normalizeTagList(tags: readonly unknown[]): string[] {
  return tags.filter((t): t is string => typeof t === "string").map(t => t.trim()).filter(Boolean);
}

/**
 * True when the tag is the brain's own bookkeeping rather than the user's word.
 *
 * Codex review, T-0102: the "new" namespaces (quarantine:, edited-canonical:, the Track 7
 * prefixes) are checked in the exact format the system writes (isNewReservedTag, itself
 * isRecognizedReservedTagFormat), not by prefix alone -- a 3.7 tag that merely shares one of
 * these prefixes (`outcome:won`, `quarantine:2020`, both predating this contract) is an ORDINARY
 * user tag: applyTagReplacement must be free to drop it like any other when a replacement omits
 * it, not treat it as the Worker's own and keep it regardless. The pre-4.0 prefixes
 * (OLD_RESERVED_PREFIXES) keep their existing prefix-only match; see that constant's own comment.
 */
export function isWorkerOwnedTag(tag: string): boolean {
  if (typeof tag !== "string") return false;
  const t = tag.trim().toLowerCase();
  if (!t) return false;
  if (PIPELINE_TAG_NAMES.has(t)) return true;
  if (OLD_RESERVED_PREFIXES.some((p) => t.startsWith(p))) return true;
  return isNewReservedTag(t);
}

/**
 * Every namespace THIS contract reserved on top of the pre-4.0 set: the trust
 * tags (quarantine:, edited-canonical:) and the Track 7 tags (standing:,
 * ledger:, confidence:, confidence-source:, outcome:, review-rearms:,
 * counterparty:, owed-to-me).
 *
 * The pre-4.0 namespaces (kind:, status:, capsule:, capsule-slot:) have a
 * separate, pre-existing gap: a caller-supplied one is neither stripped nor
 * rejected on capture or replacement (see the module comment above). That
 * gap predates this contract and is unchanged here; this guard is scoped to
 * what this contract added, so a forged `quarantine:` or `standing:active`
 * can never enter through a caller's own tags.
 */
const NEW_RESERVED_NAMES = new Set<string>([OWED_TO_ME_TAG]);

/**
 * True for a tag in a namespace this contract reserved, in the exact format the system itself
 * writes (isRecognizedReservedTagFormat below) — not merely sharing a prefix with one.
 *
 * Codex review, T-0102: a prefix-only check here stripped a 3.7 brain's own pre-existing tag
 * that happens to share a prefix this contract later reserved (an `outcome:won` or
 * `quarantine:review` from before 4.0 existed) the moment it passed back through capture or
 * replacement — contradicting CHANGELOG's own promise that such a tag "keeps showing normally;
 * nothing stored is rewritten." isRecognizedReservedTagFormat already drew this exact line for
 * display (public/utils.js's isSystemTag); the write-time guard now draws it the same way, so
 * stripping and display never disagree about which tag is really the system's.
 */
export function isNewReservedTag(tag: string): boolean {
  if (typeof tag !== "string") return false;
  const t = tag.trim().toLowerCase();
  if (!t) return false;
  if (NEW_RESERVED_NAMES.has(t)) return true;
  return isRecognizedReservedTagFormat(t);
}

/**
 * Drops any caller-supplied tag in a namespace this contract reserved. Used
 * at every write path that takes caller tags: capture (normalizeCaptureInput,
 * src/capture/entry.ts) and replacement (applyTagReplacement below). Reports
 * what it dropped so the caller can be told honestly.
 */
export function stripNewReservedTags(tags: readonly string[]): { kept: string[]; ignored: string[] } {
  const kept: string[] = [];
  const ignored: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const t = tag.trim();
    if (!t) continue;
    (isNewReservedTag(t) ? ignored : kept).push(t);
  }
  return { kept, ignored };
}

/** One plain line naming what was not saved; empty when nothing was dropped. */
export function reservedTagsNote(ignored: readonly string[]): string {
  if (!ignored.length) return "";
  return ignored.length === 1
    ? `Left off a tag Second Brain sets itself: ${ignored[0]}.`
    : `Left off tags Second Brain sets itself: ${ignored.join(", ")}.`;
}

/**
 * True when a tag in a namespace this contract reserved ALSO matches the
 * system's own value format for that namespace -- not just the prefix.
 *
 * Codex cross-vendor review, MINOR then MAJOR (T-0102): a pre-existing user tag that merely
 * looks like one of these (a genuine `outcome:won` or `confidence:high` someone tagged before
 * 4.0) must not vanish from the dashboard, and must not be stripped back out the moment it
 * passes through capture or replacement either -- isNewReservedTag (above) now calls this
 * directly, so the write-time guard and the display guard draw the exact same line.
 * public/utils.js's isSystemTag mirrors this function's own rules (utils.js cannot import
 * TypeScript) for the same reason: display and storage must never disagree about which tag is
 * the system's. Stored data is never rewritten by either side.
 */
export function isRecognizedReservedTagFormat(tag: string): boolean {
  if (typeof tag !== "string") return false;
  const t = tag.trim().toLowerCase();
  if (t.startsWith(QUARANTINE_TAG_PREFIX)) return isHoldReasonValue(t.slice(QUARANTINE_TAG_PREFIX.length));
  if (t.startsWith(EDITED_CANONICAL_TAG_PREFIX)) return isEditedCanonicalDateValue(t.slice(EDITED_CANONICAL_TAG_PREFIX.length));
  if (t.startsWith(STANDING_TAG_PREFIX)) return isStandingValue(t.slice(STANDING_TAG_PREFIX.length));
  if (t.startsWith(LEDGER_TAG_PREFIX)) return isLedgerValue(t.slice(LEDGER_TAG_PREFIX.length));
  if (t.startsWith(CONFIDENCE_SOURCE_TAG_PREFIX)) return isConfidenceSourceValue(t.slice(CONFIDENCE_SOURCE_TAG_PREFIX.length));
  if (t.startsWith(CONFIDENCE_TAG_PREFIX)) return isConfidenceValue(t.slice(CONFIDENCE_TAG_PREFIX.length));
  if (t.startsWith(OUTCOME_TAG_PREFIX)) return isOutcomeValue(t.slice(OUTCOME_TAG_PREFIX.length));
  if (t.startsWith(REVIEW_REARMS_TAG_PREFIX)) return isReviewRearmsValue(t.slice(REVIEW_REARMS_TAG_PREFIX.length));
  if (t.startsWith(COUNTERPARTY_TAG_PREFIX)) return isCounterpartyValue(t.slice(COUNTERPARTY_TAG_PREFIX.length));
  return false;
}

/** The grammar error for a project slug, or null when it is valid. One string, everywhere. */
export function projectSlugError(slug: string): string | null {
  return PROJECT_SLUG_RE.test(slug) ? null : `invalid project tag "${slug}": must match [a-z0-9][a-z0-9_-]{0,63}`;
}

/**
 * Error text for the first `project:<x>` tag whose `<x>` breaks the slug grammar, or
 * null. The prefix matches case-insensitively and trimmed, as captureEntry normalizes
 * it; the slug itself must already be lowercase so no mixed-case row is ever written.
 */
export function projectTagError(tags: readonly unknown[]): string | null {
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const t = tag.trim();
    if (!t.toLowerCase().startsWith(PROJECT_TAG_PREFIX)) continue;
    const error = projectSlugError(t.slice(PROJECT_TAG_PREFIX.length));
    if (error) return error;
  }
  return null;
}

/** The tag list with `project:<slug>` unioned in (multi-project membership stays legal). */
export function withProjectTag(tags: readonly string[], slug: string): string[] {
  const tag = `${PROJECT_TAG_PREFIX}${slug}`;
  return tags.some(t => t.trim().toLowerCase() === tag) ? [...tags] : [...tags, tag];
}

/** True for both Prompt Capsule namespaces, case-insensitively. */
export function isCapsuleTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  return t.startsWith(CAPSULE_TAG_PREFIX) || t.startsWith(CAPSULE_SLOT_TAG_PREFIX);
}

/** True when any tag in the list is a capsule tag; non-strings are ignored. */
export function hasCapsuleTag(tags: readonly unknown[]): boolean {
  return tags.some((t) => typeof t === "string" && isCapsuleTag(t));
}

/**
 * The tag set a replacement should start from: everything the Worker owns on the
 * entry today, with the caller's tags layered on top.
 *
 * Callers pass only the tags a person can see and edit, so anything they omit
 * was either removed on purpose or was never theirs to send.
 *
 * The capsule namespaces are the one exception: a replacement that names any
 * `capsule:` or `capsule-slot:` tag redefines the whole capsule membership, so
 * the existing tags in both namespaces are dropped first. A replacement that
 * names none leaves the definition exactly as it was.
 */
export function applyTagReplacement(existing: string[], replacement: string[]): string[] {
  // A caller cannot forge a namespace this contract reserved through a
  // replacement list either -- see stripNewReservedTags above. An existing,
  // legitimately-set reserved tag still survives through `kept` below,
  // exactly like status: or capsule: do.
  const { kept: cleaned } = stripNewReservedTags(replacement.map((t) => t.trim()).filter(Boolean));
  const redefinesCapsule = cleaned.some(isCapsuleTag);
  const kept = existing.filter((t) => isWorkerOwnedTag(t) && !(redefinesCapsule && isCapsuleTag(t)));
  return [...kept, ...cleaned];
}

/** Bound caller-supplied metadata before capture or replacement. */
export const MAX_INPUT_TAGS = 64;
export const MAX_INPUT_TAG_CHARS = 128;
export function validInputTags(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_INPUT_TAGS
    && value.every(tag => typeof tag === "string" && tag.length <= MAX_INPUT_TAG_CHARS && !tag.includes("\0"));
}
