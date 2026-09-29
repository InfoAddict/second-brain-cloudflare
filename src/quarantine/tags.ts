// Track 4 (self-protecting) shared contract: the quarantine tag namespace,
// the canonical-edit label, and the caller-tag guard for both. A change to
// this file is a spec revision, not a lane decision (16-t3-t4-trust-spec.md 6.1).
import { withStatus } from "../memory/status";

export const QUARANTINE_TAG_PREFIX = "quarantine:";
export const EDITED_CANONICAL_TAG_PREFIX = "edited-canonical:";

export type HoldReason = "instruction" | "hidden" | "burst" | "capsule" | "too_long";
const HOLD_REASONS: readonly HoldReason[] = ["instruction", "hidden", "burst", "capsule", "too_long"];
const EDITED_CANONICAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * MINOR fix (T-0102 cross-vendor review): matches only the app's own recognized hold-reason
 * values, not the whole `quarantine:` prefix. A pre-4.0 user tag that merely starts with this
 * prefix (`quarantine:review`, written before the hold mechanism existed) is not one of the five
 * values `withHold` ever writes, so it must not read as held -- there is no hold version for it,
 * so a row stuck this way could never be released (undo finds nothing_to_undo). The only wildcard
 * in each clause is the leading and trailing `%` that match the JSON array's neighbours; the
 * literal itself carries no LIKE metacharacter.
 */
export const NOT_HELD_SQL = HOLD_REASONS.map(r => `tags NOT LIKE '%"${QUARANTINE_TAG_PREFIX}${r}"%'`).join(" AND ");

/**
 * NOT_HELD_SQL, with every `tags` reference qualified by `alias.` -- needed at a call site that
 * joins two tables both carrying a `tags` column, where a bare `${alias}.${NOT_HELD_SQL}` would
 * leave every clause after the first unqualified (and ambiguous, since both sides have one).
 */
export function notHeldSql(alias: string): string {
  return HOLD_REASONS.map(r => `${alias}.tags NOT LIKE '%"${QUARANTINE_TAG_PREFIX}${r}"%'`).join(" AND ");
}

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

/**
 * True when any tag holds the row out of recall. A `quarantine:` tag only counts when its value
 * is one of the app's own recognized hold reasons (heldReason, below) -- MINOR fix, see NOT_HELD_SQL.
 */
export function isHeld(tags: readonly string[]): boolean {
  return heldReason(tags) !== null;
}

/**
 * Codex review class E (T-0089.4.2): the one gate between a candidate row and any AI model
 * prompt — contradiction, duplicate/merge, digest, insight, classify, or anything else. A held
 * row's content is unreviewed (that is what the hold means); every candidate-row query behind a
 * model call must select `tags` and filter its results through this before any row's content is
 * spliced into a prompt. See test/unit/model-prompt-held-inventory.test.ts.
 */
export function excludeHeld<T extends { tags: string | null | undefined }>(rows: readonly T[]): T[] {
  return rows.filter(r => {
    try { return !isHeld(JSON.parse(r.tags ?? "[]")); } catch { return true; }
  });
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
 * The one plain-English phrase per hold reason, shared by every agent-facing reply (5.5). Since
 * the MINOR fix above, `isHeld` and `heldReason` agree exactly (a row is held only by a
 * recognized reason), so `null` is unreachable from a caller that already checked `isHeld` first
 * -- kept as a generic fallback for any caller that has not, rather than removed.
 */
export function holdReasonPhrase(reason: HoldReason | null): string {
  switch (reason) {
    case "instruction": return "it looks like an instruction to an AI";
    case "hidden": return "it contains hidden text";
    case "burst": return "many memories were written in a short time";
    case "capsule": return "it changes what your AI tools always see";
    case "too_long": return "it is too long to check automatically for hidden instructions";
    case null: return "it was held automatically";
  }
}

/**
 * Copy deck 9.1 (T-0089.4.2, replacing the withdrawn pending-scan design): a too_long hold gets
 * its own MCP reply shape, not the generic "Stored, but held out of recall: <phrase>. The user
 * can release it." template — there is no automatic check to wait on, only the owner reading it
 * and releasing it, or saving it shorter next time. `verb` is "Stored"/"Updated"/"Appended",
 * matching remember/update/append.
 */
export function tooLongReplyText(verb: "Stored" | "Updated" | "Appended", id: string): string {
  return `${verb}. ID: ${id}. Held out of search: it is too long to check automatically for hidden `
    + "instructions. Ask the user to read it in the dashboard and release it if it's fine. Saving "
    + "it as shorter memories (about 5,000 words or less each) avoids the hold.";
}
