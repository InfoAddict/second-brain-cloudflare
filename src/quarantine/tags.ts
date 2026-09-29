// Track 4 (self-protecting) shared contract: the quarantine tag namespace,
// the canonical-edit label, and the caller-tag guard for both. A change to
// this file is a spec revision, not a lane decision (16-t3-t4-trust-spec.md 6.1).
import { getStatus, withStatus } from "../memory/status";

export const QUARANTINE_TAG_PREFIX = "quarantine:";
export const EDITED_CANONICAL_TAG_PREFIX = "edited-canonical:";

export type HoldReason = "instruction" | "hidden" | "burst" | "capsule" | "too_long";
const HOLD_REASONS: readonly HoldReason[] = ["instruction", "hidden", "burst", "capsule", "too_long"];

/** Escapes `%`, `_` and `\` for a SQLite `LIKE ... ESCAPE '\'` pattern, so `too_long`'s literal
 * underscore can't act as LIKE's single-character wildcard and widen the match. */
function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

/**
 * Excludes a row when EITHER of two things is true (Codex review, T-0102):
 *
 * 1. It carries a `quarantine:<reason>` tag matching one of the five exact reasons this Worker
 *    ever writes, whatever its other tags — a recognized reason is never coincidental (see
 *    `heldReason`), so it holds a row unconditionally, the same as `isInsightEligible`'s "held
 *    whatever its other tags" contract.
 * 2. It carries ANY `quarantine:`-prefixed tag paired with `status:draft` in the same row — the
 *    exact shape `withHold` always writes together. Broader than (1) on purpose: a row shaped
 *    like this Worker's own hold but carrying a reason this build doesn't recognize (a newer
 *    version's sixth reason, or a forged tag) still holds out of caution, matching the
 *    agent-facing reader's `heldReason(tags) ?? "unrecognized"` fallback (src/mcp/server.ts).
 *
 * A 3.7 brain's own `quarantine:2020` or `quarantine:review` tag matches neither: "2020" and
 * "review" are not recognized reasons, and pre-4.0 writers never paired either with status:draft.
 * That tag stays an ordinary user tag.
 *
 * Starts with the bare column name `tags`, like the single-condition form this replaces, so every
 * existing call site's `${NOT_HELD_SQL}` (unqualified, one `entries`-shaped table in scope) still
 * reads correctly. A query that joins two tag-bearing tables under aliases cannot safely splice
 * this in more than once with only the first `tags` qualified — use `notHeldSqlFor(alias)` there.
 */
export const NOT_HELD_SQL = `${HOLD_REASONS.map(
  r => `tags NOT LIKE '%"${QUARANTINE_TAG_PREFIX}${likeLiteral(r)}"%' ESCAPE '\\'`,
).join(" AND ")} AND (tags NOT LIKE '%"${QUARANTINE_TAG_PREFIX}%' OR tags NOT LIKE '%"status:draft"%')`;

/** `NOT_HELD_SQL`, with every `tags` reference qualified by `alias` — for a query where more than
 * one tag-bearing table is in scope (a self-join) and a bare `tags` would be ambiguous. */
export function notHeldSqlFor(alias: string): string {
  return `${HOLD_REASONS.map(
    r => `${alias}.tags NOT LIKE '%"${QUARANTINE_TAG_PREFIX}${likeLiteral(r)}"%' ESCAPE '\\'`,
  ).join(" AND ")} AND (${alias}.tags NOT LIKE '%"${QUARANTINE_TAG_PREFIX}%' OR ${alias}.tags NOT LIKE '%"status:draft"%')`;
}
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

/**
 * True when a row is held out of recall: `heldReason` recognizes its reason (unconditional — see
 * `NOT_HELD_SQL`'s own comment for why), or it carries some `quarantine:`-prefixed tag paired with
 * `status:draft` in the same row (defense in depth for an unrecognized reason). A 3.7 brain's own
 * `quarantine:2020` or `quarantine:review` tag matches neither and is never held.
 */
export function isHeld(tags: readonly string[]): boolean {
  if (heldReason(tags) !== null) return true;
  if (getStatus(tags) !== "draft") return false;
  return tags.some(t => isTagString(t) && t.trim().toLowerCase().startsWith(QUARANTINE_TAG_PREFIX));
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
