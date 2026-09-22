/**
 * The time-anchor primitive, shared by every explicit producer: MCP
 * remember/append and POST /capture. `when_kind` names what kind of moment
 * this is; `when_source` (not validated here, always "explicit" on this path)
 * distinguishes a caller-supplied date from src/when/heuristic.ts's regex
 * guess or src/when/pass.ts's model judgment.
 */
export const WHEN_KIND_VALUES = ["due", "event", "wake"] as const;
export type WhenKind = (typeof WHEN_KIND_VALUES)[number];

export const WHEN_SOURCE_VALUES = ["explicit", "regex", "model"] as const;
export type WhenSource = (typeof WHEN_SOURCE_VALUES)[number];

/** Past this far out, a "when" is more likely a typo than a real anchor. */
export const WHEN_MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export interface ExplicitWhen {
  at: number;
  kind: WhenKind;
  source: "explicit";
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
  const at = Date.parse(trimmed);
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
