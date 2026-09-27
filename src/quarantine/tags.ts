// Track 4 (self-protecting) shared contract: the quarantine tag namespace,
// the canonical-edit label, and the caller-tag guard for both. A change to
// this file is a spec revision, not a lane decision (16-t3-t4-trust-spec.md 6.1).
//
// This commit only reserves the namespaces and defines the pure helpers.
// Nothing calls withHold, withEditedCanonical or stripReservedTrustTags yet --
// the write paths that score, hold and release memories are Track 4's own
// tasks, built on top of this contract. No behaviour changes here.
import { withStatus } from "../memory/status";

export const QUARANTINE_TAG_PREFIX = "quarantine:";
export const EDITED_CANONICAL_TAG_PREFIX = "edited-canonical:";

/**
 * The only wildcard is the leading and trailing `%` that match the JSON
 * array's neighbours; the literal itself carries no LIKE metacharacter.
 */
export const NOT_HELD_SQL = `tags NOT LIKE '%"${QUARANTINE_TAG_PREFIX}%'`;

export type HoldReason = "instruction" | "hidden" | "burst" | "capsule";
const HOLD_REASONS: readonly HoldReason[] = ["instruction", "hidden", "burst", "capsule"];
const EDITED_CANONICAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isTagString(t: unknown): t is string {
  return typeof t === "string";
}

/** True when a bare value (no prefix) is a recognized hold reason. */
export function isHoldReasonValue(value: string): value is HoldReason {
  return (HOLD_REASONS as readonly string[]).includes(value);
}

/** True when a bare value (no prefix) is a YYYY-MM-DD date, the canonical-edit label's shape. */
export function isEditedCanonicalDateValue(value: string): boolean {
  return EDITED_CANONICAL_DATE_RE.test(value);
}

/** True when any tag holds the row out of recall, whatever the reason. */
export function isHeld(tags: readonly string[]): boolean {
  return tags.some(t => isTagString(t) && t.trim().toLowerCase().startsWith(QUARANTINE_TAG_PREFIX));
}

/** The row's hold reason, or null when it is not held or the reason is unrecognized. */
export function heldReason(tags: readonly string[]): HoldReason | null {
  for (const tag of tags) {
    if (!isTagString(tag)) continue;
    const t = tag.trim().toLowerCase();
    if (!t.startsWith(QUARANTINE_TAG_PREFIX)) continue;
    const reason = t.slice(QUARANTINE_TAG_PREFIX.length);
    if ((HOLD_REASONS as readonly string[]).includes(reason)) return reason as HoldReason;
  }
  return null;
}

/** Replaces any existing hold tag with the given reason, and sets status:draft (5.4). */
export function withHold(tags: readonly string[], reason: HoldReason): string[] {
  const withoutHold = tags.filter(t => !(isTagString(t) && t.trim().toLowerCase().startsWith(QUARANTINE_TAG_PREFIX)));
  return withStatus([...withoutHold, `${QUARANTINE_TAG_PREFIX}${reason}`], "draft");
}

/** The canonical-edit label's date ("YYYY-MM-DD"), or null when the row carries none (5.7). */
export function editedCanonicalAt(tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (!isTagString(tag)) continue;
    const t = tag.trim();
    if (!t.toLowerCase().startsWith(EDITED_CANONICAL_TAG_PREFIX)) continue;
    return t.slice(EDITED_CANONICAL_TAG_PREFIX.length);
  }
  return null;
}

/** Sets today's (UTC) canonical-edit label, replacing any earlier one (5.7). */
export function withEditedCanonical(tags: readonly string[], now: number): string[] {
  const withoutLabel = tags.filter(t => !(isTagString(t) && t.trim().toLowerCase().startsWith(EDITED_CANONICAL_TAG_PREFIX)));
  const date = new Date(now).toISOString().slice(0, 10);
  return [...withoutLabel, `${EDITED_CANONICAL_TAG_PREFIX}${date}`];
}

/**
 * Drops any caller-supplied quarantine:* or edited-canonical:* tag, so an
 * agent cannot hide a true memory by tagging it, or forge the trust label.
 *
 * Pure and unwired in this commit; see the module comment.
 */
export function stripReservedTrustTags(tags: readonly string[]): string[] {
  return tags.filter(t => {
    if (!isTagString(t)) return true;
    const lower = t.trim().toLowerCase();
    return !lower.startsWith(QUARANTINE_TAG_PREFIX) && !lower.startsWith(EDITED_CANONICAL_TAG_PREFIX);
  });
}

/**
 * The one plain-English phrase per hold reason, shared by every agent-facing
 * reply (5.5). A row is held by ANY `quarantine:` tag, whatever the reason —
 * `heldReason` returns null for one it does not recognize, and that row is
 * still held: pass null through here for the generic phrase rather than
 * treating an unrecognized reason as "not held".
 */
export function holdReasonPhrase(reason: HoldReason | null): string {
  switch (reason) {
    case "instruction": return "it looks like an instruction to an AI";
    case "hidden": return "it contains hidden text";
    case "burst": return "many memories were written in a short time";
    case "capsule": return "it changes what your AI tools always see";
    case null: return "it was held automatically";
  }
}
