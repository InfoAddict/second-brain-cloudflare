/**
 * Cross-validation shared by MCP remember and REST /capture for the three
 * mutually-exclusive Track 7 capture modes (standing, decision, commitment),
 * plus the pure tag composition for a commitment (Design 2.1 point 1, 4.1,
 * 5.1). Decision's own field rules and tag/when composition stay in
 * src/decisions/capture.ts; this module only adds the standing- and
 * commitment-primary directions of the same refusal, so whichever mode the
 * caller actually asked for reports its own wording.
 */
import { validateDecisionCapture, type DecisionCaptureInput } from "../decisions/capture";
import { counterpartyName, counterpartySlug, COUNTERPARTY_TAG_PREFIX, OWED_TO_ME_TAG, type CommitmentDirection } from "../commitments/direction";
import { stripT7CallerTags, STANDING_TAG_PREFIX, LEDGER_TAG_PREFIX } from "../tags/t7";

export type T7CaptureInput = DecisionCaptureInput;

const STANDING_CONFLICT_ERROR = "A standing instruction can't also be a decision or a commitment. Nothing was saved.";
const COMMITMENT_BOTH_ERROR = "Use owed_by or owed_to, not both. Nothing was saved.";

/**
 * Runs decision's own validation first (it already reports the decision-only
 * field checks and the decision-primary conflict message), then the standing-
 * and commitment-primary directions of the same three-way refusal. Whichever
 * mode the caller actually set (decision, then standing, then commitment)
 * owns the wording, so setting two modes always reports the one the caller
 * most likely meant to keep rather than a generic "conflict" message.
 */
export function validateT7Capture(input: T7CaptureInput): { error: string } | null {
  const decisionError = validateDecisionCapture(input);
  if (decisionError) return decisionError;

  if (input.standing && (input.decision || input.owed_by !== undefined || input.owed_to !== undefined)) {
    return { error: STANDING_CONFLICT_ERROR };
  }

  const hasCommitment = input.owed_by !== undefined || input.owed_to !== undefined;
  if (hasCommitment) {
    if (input.owed_by !== undefined && input.owed_to !== undefined) return { error: COMMITMENT_BOTH_ERROR };
    if (input.decision || input.standing) return { error: STANDING_CONFLICT_ERROR };
  }

  return null;
}

/** What captureEntry actually did with a T7 request, for the MCP/REST reply layer to word. */
export type T7ReplyInfo =
  | { kind: "standing"; applied: true }
  | { kind: "standing"; applied: false; reason: "cap" | "too_long" }
  | {
    kind: "decision";
    when_at: number;
    confidence?: { value: number; source: "stated" | "inferred"; reason?: "the lowest allowed" | "the highest allowed" };
  }
  | { kind: "commitment"; direction: CommitmentDirection; counterpartyLabel?: string; slugDropped?: true };

export interface CommitmentCaptureResult {
  tags: string[];
  direction: CommitmentDirection;
  /** Display name, absent when the counterparty's name yielded an empty slug. */
  counterpartyLabel?: string;
  /** True when a name was given but stripped to nothing (Design 5.1): the reply notes it. */
  slugDropped?: true;
}

/**
 * owed_by "Priya" -> task, owed-to-me, counterparty:priya (inbound: something owed TO the user).
 * owed_to "Sam" -> task, counterparty:sam (outbound: something the user owes).
 * Caller has already refused the case where both are given (validateT7Capture).
 */
export function buildCommitmentTags(input: Pick<T7CaptureInput, "owed_by" | "owed_to">): CommitmentCaptureResult {
  const name = input.owed_by ?? input.owed_to ?? "";
  const direction: CommitmentDirection = input.owed_by !== undefined ? "in" : "out";
  const tags = ["task", ...(direction === "in" ? [OWED_TO_ME_TAG] : [])];

  const slug = counterpartySlug(name);
  if (!slug) return { tags, direction, slugDropped: true };

  return { tags: [...tags, `${COUNTERPARTY_TAG_PREFIX}${slug}`], direction, counterpartyLabel: counterpartyName(slug) };
}

/**
 * Design 1.3: "Note: the tag "standing:active" was ignored; use standing: true." One line
 * per caller-supplied tag in a T7 namespace — those are always dropped before capture
 * (stripT7CallerTags mirrors normalizeCaptureInput's own strip, src/tags/t7.ts), because the
 * typed parameter is where the cap, quarantine signal and when wiring live.
 */
export function t7IgnoredTagNotes(tags: readonly string[]): string[] {
  const { ignored } = stripT7CallerTags(tags);
  return ignored.map(tag => {
    const lower = tag.toLowerCase();
    const hint = lower.startsWith(STANDING_TAG_PREFIX) ? "standing: true"
      : lower.startsWith(LEDGER_TAG_PREFIX) ? "decision: true"
        : lower === "owed-to-me" ? "owed_by"
          : null;
    return hint
      ? `Note: the tag "${tag}" was ignored; use ${hint}.`
      : `Note: the tag "${tag}" was ignored; it is set automatically.`;
  });
}

/**
 * Splits a caller's reserved-tag rejections (src/tags/system.ts's stripNewReservedTags)
 * into T7's own per-tag notes and everything else (quarantine:, edited-canonical:), so a
 * tag never appears in both the specific and the generic note.
 */
export function partitionIgnoredTags(rawTags: readonly string[], allIgnored: readonly string[]): { t7Notes: string[]; otherIgnored: string[] } {
  const t7Lower = new Set(stripT7CallerTags(rawTags).ignored.map(t => t.toLowerCase()));
  return {
    t7Notes: t7IgnoredTagNotes(rawTags),
    otherIgnored: allIgnored.filter(t => !t7Lower.has(t.toLowerCase())),
  };
}

// ── Reply wording (Chat table, "UX journeys per touchpoint") ────────────────
// Shared by MCP remember and REST /capture so the two surfaces cannot drift.

/** "Sep 1" — the promised-date form the commitment replies use. */
export function formatMonthDay(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric" }).format(ms);
}

/** "Dec 26, 2026" — the review-date form the decision reply uses. */
export function formatMonthDayYear(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric" }).format(ms);
}

const CLAMP_REASON_LABEL: Record<"the lowest allowed" | "the highest allowed", string> = {
  "the lowest allowed": "the ledger's minimum",
  "the highest allowed": "the ledger's maximum",
};

/** "Saved as a standing instruction..." / the cap / too-long replies (Design 2.1 points 2-3, 6). */
export function standingReplyText(id: string, outcome: Extract<T7ReplyInfo, { kind: "standing" }>, hasProject: boolean): string {
  if (!outcome.applied) {
    return outcome.reason === "cap"
      ? `Standing memory limit reached; this was saved as an ordinary memory. Stop an old one to make room. ID: ${id}`
      : `Saved as an ordinary memory: a standing instruction must be under 500 characters. ID: ${id}`;
  }
  return hasProject
    ? `Saved as a standing instruction. In this project it is listed when a session starts, and shown when a question matches it. ID: ${id}`
    : `Saved as a standing instruction. It will come up when this topic does, in any AI tool. ID: ${id}`;
}

/** "Logged the decision. I'll bring it up for review around <date>. ID: X (confidence 0.7, stated)" (Design 4.1). */
export function decisionReplyText(id: string, outcome: Extract<T7ReplyInfo, { kind: "decision" }>, timezone: string): string {
  const date = formatMonthDayYear(outcome.when_at, timezone);
  const base = `Logged the decision. I'll bring it up for review around ${date}. ID: ${id}`;
  if (!outcome.confidence) return base;
  const { value, source, reason } = outcome.confidence;
  const qualifier = reason ? ` — ${CLAMP_REASON_LABEL[reason]}` : "";
  return `${base} (confidence ${value}${qualifier}, ${source})`;
}

/** "Tracking it as owed to you by Priya, due Sep 1. ID: X" (Design 5.1). */
export function commitmentReplyText(
  id: string, outcome: Extract<T7ReplyInfo, { kind: "commitment" }>, whenAt: number | undefined, timezone: string,
): string {
  const due = whenAt !== undefined ? `, due ${formatMonthDay(whenAt, timezone)}` : "";
  const who = outcome.counterpartyLabel;
  const body = outcome.direction === "in"
    ? (who ? `owed to you by ${who}` : "owed to you")
    : (who ? `something you owe ${who}` : "something you owe someone");
  return `Tracking it as ${body}${due}. ID: ${id}`;
}

/**
 * The full reply for a plain "stored" capture that carried a Track 7 mode — replaces the
 * default "Stored. ID: X" reply entirely, per the Chat table. `commitmentWhenAt` is the
 * caller's already-parsed generic `when` (a commitment's promised date is not tracked on
 * T7ReplyInfo itself, since it goes through the same when/when_kind path any capture does).
 */
export function t7ReplyText(
  id: string, outcome: T7ReplyInfo, opts: { timezone: string; hasProject: boolean; commitmentWhenAt?: number },
): string {
  if (outcome.kind === "standing") return standingReplyText(id, outcome, opts.hasProject);
  if (outcome.kind === "decision") return decisionReplyText(id, outcome, opts.timezone);
  return commitmentReplyText(id, outcome, opts.commitmentWhenAt, opts.timezone);
}
