/**
 * The time-anchor primitive, shared by every explicit producer: MCP
 * remember/append and POST /capture. `when_kind` names what kind of moment
 * this is; `when_source` (not validated here, always "explicit" on this path)
 * distinguishes a caller-supplied date from src/when/heuristic.ts's regex
 * guess or src/when/pass.ts's model judgment.
 *
 * NORMALIZATION (Finding 5). `Date.parse` reads a bare date ("2026-06-15")
 * as UTC midnight but a bare datetime with no offset ("2026-06-15T09:00:00")
 * as the RUNNING PROCESS'S OWN LOCAL TIME — two different rules for two
 * inputs that look equally "plain" to a caller, and the second one is not
 * even deterministic across deployments. This module picks one rule for
 * both: a bare date stays UTC midnight, and a datetime with no explicit
 * offset is treated as UTC (a trailing "Z" is appended before parsing).
 * Pass a plain date or a full offset datetime — never a bare datetime and
 * expect it to mean anything but UTC.
 */
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

/** ISO 8601 date only, no time component — Date.parse already reads this as UTC midnight. */
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Carries an explicit UTC ("Z") or numeric offset already. */
const HAS_TIMEZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

/** See the NORMALIZATION note above: a bare datetime is forced to UTC rather than left runtime-local. */
function normalizeToUtc(raw: string): string {
  if (BARE_DATE_RE.test(raw) || HAS_TIMEZONE_RE.test(raw)) return raw;
  return `${raw}Z`;
}

/**
 * Validates a caller-supplied `when` (ISO 8601 date or datetime) and optional
 * `when_kind`, defaulting the kind to "wake" — a reminder to come back to
 * this, absent a more specific label. No restriction on the past: a
 * retroactive "this was due on" is a legitimate use, only the future is
 * bounded, against fat-fingering a year.
 */
export function parseExplicitWhen(
  rawWhen: string,
  rawKind: unknown,
  now: number = Date.now(),
): { value?: ExplicitWhen; error?: string } {
  const trimmed = rawWhen.trim();
  const at = trimmed ? Date.parse(normalizeToUtc(trimmed)) : NaN;
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
