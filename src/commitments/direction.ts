/**
 * Which way a two-way commitment points, and its counterparty. Derived from
 * OPEN_LOOP_SQL (src/memory/loops.ts), which stays the single definition of
 * "open" — this module only splits that open set by direction. Kept out of
 * memory/loops.ts so it does not collide with Track 1.
 */
import { OPEN_LOOP_SQL } from "../memory/loops";
import { PROJECT_SLUG_RE } from "../tags/system";
import { LEDGER_TAG } from "../tags/t7";

/** Bare marker written when someone else owes the user something (owed_by on capture). */
export const OWED_TO_ME_TAG = "owed-to-me";
export const OWED_TO_ME_SQL = `tags LIKE '%"${OWED_TO_ME_TAG}"%'`;

/** Open loops the user owes someone else. */
export const OPEN_OUTBOUND_SQL = `(${OPEN_LOOP_SQL}) AND NOT (${OWED_TO_ME_SQL})`;
/** Open loops someone else owes the user. */
export const OPEN_INBOUND_SQL = `(${OPEN_LOOP_SQL}) AND ${OWED_TO_ME_SQL}`;

export type CommitmentDirection = "out" | "in";

/** "in" when the row carries the inbound marker, "out" otherwise. */
export function directionOf(tags: string[]): CommitmentDirection {
  return tags.includes(OWED_TO_ME_TAG) ? "in" : "out";
}

export const COUNTERPARTY_TAG_PREFIX = "counterparty:";

/**
 * A counterparty's name reduced to its tag slug: lowercase, spaces to
 * hyphens, anything outside [a-z0-9_-] stripped, then checked against the
 * project slug grammar (PROJECT_SLUG_RE). A name with nothing left after
 * stripping — or one that starts with a character the grammar refuses —
 * yields "", so the caller writes no counterparty tag rather than a
 * malformed one.
 */
export function counterpartySlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
  return PROJECT_SLUG_RE.test(slug) ? slug : "";
}

/** The display form of a counterparty slug: "dana-smith" -> "Dana Smith". */
export function counterpartyName(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** The counterparty tag's display name, or undefined when the row carries none (Design 5.3). */
export function counterpartyOf(tags: readonly string[]): string | undefined {
  const tag = tags.find(t => t.startsWith(COUNTERPARTY_TAG_PREFIX));
  return tag ? counterpartyName(tag.slice(COUNTERPARTY_TAG_PREFIX.length)) : undefined;
}

export type DueKind = "decision" | "inbound" | "outbound" | "other";

/**
 * GET /due's `kind` (Design 5.3), derived from tags in JS — no SQL change, since rows already
 * carry tags. A decision review always wins the label even if it also carried a task tag
 * (it never does in practice: decision capture and commitment capture are mutually exclusive).
 */
export function dueKindOf(tags: readonly string[]): DueKind {
  if (tags.includes(LEDGER_TAG)) return "decision";
  if (tags.includes(OWED_TO_ME_TAG)) return "inbound";
  if (tags.includes("task")) return "outbound";
  return "other";
}
