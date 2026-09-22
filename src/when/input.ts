/**
 * The time-anchor primitive, shared by every explicit producer: MCP
 * remember/append and POST /capture. `when_kind` names what kind of moment
 * this is; `when_source` (not validated here, always "explicit" on this path)
 * distinguishes a caller-supplied date from src/when/heuristic.ts's regex
 * guess or src/when/pass.ts's model judgment.
 *
 * NORMALIZATION (Finding 5, revised). `Date.parse` reads a bare date
 * ("2026-06-15") as UTC midnight but a bare datetime with no offset
 * ("2026-06-15T09:00:00") as the RUNNING PROCESS'S OWN LOCAL TIME — two
 * different rules for two inputs that look equally "plain" to a caller, and
 * the second one is not even deterministic across deployments. This module
 * picks one rule for both, and it is no longer "always UTC": a bare date or
 * an offsetless datetime anchors midnight (or its wall-clock time) in the
 * brain's configured TIMEZONE (src/config.ts, src/when/timezone.ts) —
 * "UTC" for a brain that never sets it, which is exactly today's behaviour.
 * Pass a plain date/datetime or a full offset datetime; an offset already on
 * the string is honoured as given and never reinterpreted in the configured
 * zone.
 */
import { zonedMsFromBareIso } from "./timezone";

export const WHEN_KIND_VALUES = ["due", "event", "wake"] as const;
export type WhenKind = (typeof WHEN_KIND_VALUES)[number];

export const WHEN_SOURCE_VALUES = ["explicit", "regex", "model"] as const;
export type WhenSource = (typeof WHEN_SOURCE_VALUES)[number];

/** Past this far out, a "when" is more likely a typo than a real anchor. */
export const WHEN_MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/**
 * How far into the future something counts as "upcoming" rather than just
 * "has a when at all" — GET /due's own bucket boundary, and the window
 * GET /brief's attention.due count uses so the two cannot disagree about
 * what "coming up soon" means.
 */
export const DUE_WITHIN_MS = 48 * 60 * 60 * 1000;

/**
 * "Has a time anchor at all", the one predicate GET /due and GET /brief's
 * attention.due chip both filter on — deliberately NOT OPEN_LOOP_SQL
 * (src/memory/loops.ts): that requires a "task" tag, but `when` reaches a
 * row through three independent producers (explicit, the regex pass, the
 * model pass) and none of them require the caller to have also tagged it a
 * task. Before this was shared, an untagged `remember(..., when: ...)` moved
 * GET /due but never the /brief chip, because the chip alone added the
 * task-tag requirement. Deprecated entries are excluded the same way every
 * other review queue excludes them: dismissing a memory retires it, and
 * asking someone to act on its due date is make-work.
 */
export const DUE_SQL = `when_at IS NOT NULL AND tags NOT LIKE '%"status:deprecated"%'`;

export interface ExplicitWhen {
  at: number;
  kind: WhenKind;
  source: "explicit";
}

/** Carries an explicit UTC ("Z") or numeric offset already. */
const HAS_TIMEZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Validates a caller-supplied `when` (ISO 8601 date or datetime) and optional
 * `when_kind`, defaulting the kind to "wake" — a reminder to come back to
 * this, absent a more specific label. No restriction on the past: a
 * retroactive "this was due on" is a legitimate use, only the future is
 * bounded, against fat-fingering a year.
 *
 * `timezone` anchors a bare date/datetime (no offset); an input that already
 * carries one is parsed as given and `timezone` does not apply to it. See
 * the NORMALIZATION note above.
 */
export function parseExplicitWhen(
  rawWhen: string,
  rawKind: unknown,
  now: number = Date.now(),
  timezone: string = "UTC",
): { value?: ExplicitWhen; error?: string } {
  const trimmed = rawWhen.trim();
  const at = trimmed
    ? (HAS_TIMEZONE_RE.test(trimmed) ? Date.parse(trimmed) : zonedMsFromBareIso(trimmed, timezone) ?? NaN)
    : NaN;
  if (!trimmed || Number.isNaN(at)) {
    return { error: "when must be a parseable ISO 8601 date or datetime" };
  }
  if (at - now > WHEN_MAX_FUTURE_MS) {
    return { error: "when must not be more than 5 years in the future" };
  }

  let kind: WhenKind = "wake";
  if (rawKind !== undefined && rawKind !== null) {
    if (typeof rawKind !== "string" || !(WHEN_KIND_VALUES as readonly string[]).includes(rawKind)) {
      return { error: `when_kind must be one of: ${WHEN_KIND_VALUES.join(", ")}` };
    }
    kind = rawKind as WhenKind;
  }

  return { value: { at, kind, source: "explicit" } };
}
