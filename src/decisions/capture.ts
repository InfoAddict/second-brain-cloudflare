/**
 * Decision capture rules: validation, confidence rounding, the frozen label,
 * and the review date — everything a decision's INSERT needs, computed
 * before the write rather than in it. Pure: no D1, no clock of its own.
 */
import { parseExplicitWhen } from "../when/input";
import { zonedTimeMs } from "../when/timezone";

// Literal for now, not imported from a shared reserved-tag list: Track 7's
// Lane A (src/tags/t7.ts) owns that list and lands separately. Reconcile once
// it merges.
export const LEDGER_DECISION_TAG = "ledger:decision";
export const CONFIDENCE_TAG_PREFIX = "confidence:";
export const CONFIDENCE_SOURCE_TAG_PREFIX = "confidence-source:";

export type ConfidenceSource = "stated" | "inferred";

export interface DecisionCaptureInput {
  decision?: boolean;
  confidence?: number;
  confidence_source?: ConfidenceSource;
  review_by?: string;
  when?: string;
  when_kind?: string;
  standing?: boolean;
  owed_by?: string;
  owed_to?: string;
}

// Lowercase field names deliberately: test/unit/config-threading-complete.test.ts
// flags a bare tunable name (DECISION_REVIEW_DEFAULT_DAYS, TIMEZONE) read outside
// a `cfg.` qualifier anywhere in src/, and these are declarations, not reads —
// Task 6 (Lane C, config.ts) is what actually threads cfg.DECISION_REVIEW_DEFAULT_DAYS
// and cfg.TIMEZONE into the values this interface's callers pass in.
export interface DecisionCaptureConfig {
  reviewDefaultDays: number;
  timezone: string;
}

export interface ConfidenceResult {
  value: number;
  /** Present only when the stored value differs from what was passed because it was clamped. */
  reason?: "the lowest allowed" | "the highest allowed";
}

export interface DecisionCaptureResult {
  tags: string[];
  when_at: number;
  when_kind: "due";
  when_source: "explicit";
  when_label: string;
  confidence?: ConfidenceResult & { source: ConfidenceSource };
}

/**
 * Every error below stores nothing (design 4.1). Checked in the order the
 * spec lists them, so the first applicable rule is the one reported.
 */
export function validateDecisionCapture(input: DecisionCaptureInput): { error: string } | null {
  const decisionOnlyFieldGiven = input.confidence !== undefined || input.confidence_source !== undefined || input.review_by !== undefined;
  if (decisionOnlyFieldGiven && !input.decision) {
    return { error: "confidence and review_by only work with decision: true. Nothing was saved." };
  }
  if (!input.decision) return null;

  if (input.standing || input.owed_by !== undefined || input.owed_to !== undefined) {
    return { error: "A decision can't also be a standing instruction or a commitment. Nothing was saved." };
  }
  if (input.review_by !== undefined && input.when !== undefined) {
    return { error: "Pass the review date as review_by or when, not both. Nothing was saved." };
  }
  if (input.when_kind !== undefined && input.when_kind !== "due") {
    return { error: 'A decision\'s review date is always a due date. Leave when_kind out, or use "due". Nothing was saved.' };
  }
  return null;
}

/** Clamped to [0.05, 0.95] and rounded to the nearest 0.05. 0 and anything over 1 are errors. */
export function roundConfidence(raw: number): ConfidenceResult | { error: string } {
  if (!(raw > 0) || raw > 1) {
    return { error: "confidence must be above 0 and at most 1, for example 0.7 for 70%. Nothing was saved." };
  }
  const clamped = Math.min(0.95, Math.max(0.05, raw));
  const value = Math.round(clamped * 20) / 20;
  if (raw > 0.95) return { value, reason: "the highest allowed" };
  if (raw < 0.05) return { value, reason: "the lowest allowed" };
  return { value };
}

/** The first sentence, cut at 60 characters on a word boundary, trailing punctuation removed. */
export function shortDecision(content: string): string {
  const trimmed = content.trim();
  const sentenceEnd = trimmed.search(/[.!?](?:\s|$)/);
  const firstSentence = sentenceEnd === -1 ? trimmed : trimmed.slice(0, sentenceEnd + 1);
  let cut = firstSentence.slice(0, 60);
  if (firstSentence.length > 60 && firstSentence[60] !== " ") {
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  }
  return cut.replace(/[\s.,;:!?-]+$/, "");
}

/**
 * "Review: {decision}" — an English-prefixed form for callers that render
 * straight to a person with no i18n layer of their own (push, English only
 * for now: src/push/send.ts builds this same prefix itself, since it only
 * has the stored bare label, not the full content). NOT used for the stored
 * when_label (see buildDecisionCapture below): a stored English prefix would
 * be exactly what an Italian dashboard renders unchanged, so the row is
 * marked as a decision review through its ledger:decision tag instead, and
 * each reader adds its own localized prefix.
 */
const REVIEW_PREFIX = "Review: ";

/**
 * An older stored decision row (before the bare-label fix) may still carry
 * "Review: " baked into its content or label — pushing "Review: Review: X"
 * if this simply prepended again. Strip an existing prefix defensively.
 */
export function reviewLabel(content: string): string {
  const short = shortDecision(content);
  return short.startsWith(REVIEW_PREFIX) ? short : `${REVIEW_PREFIX}${short}`;
}

/**
 * now + days CALENDAR days in timezone, at 09:00 local. Calendar-day
 * arithmetic, not a fixed 24h-per-day offset: adding days * 86400000ms to a
 * UTC instant and then reading the calendar date can land a day off across a
 * DST transition (a New York review due "in 2 days" from March 7 23:30 would
 * read back as March 10, not March 9, once spring-forward's missing hour is
 * added in as if every day were 24 real hours). The day arithmetic below
 * happens on a date-only value (no timezone, no wall clock, so DST cannot
 * touch it); only the final anchor at 09:00 goes through the real timezone.
 */
function defaultReviewAt(now: number, days: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const localDate = new Date(Date.UTC(get("year"), get("month") - 1, get("day")) + days * 86400000);
  return zonedTimeMs(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate(), 9, 0, 0, timezone);
}

/** review_by, else when, else the default (+DECISION_REVIEW_DEFAULT_DAYS at 09:00 in TIMEZONE). */
export function computeReviewAt(params: {
  review_by?: string;
  when?: string;
  now: number;
  timezone: string;
  days: number;
}): { at: number } | { error: string } {
  const explicit = params.review_by ?? params.when;
  if (explicit !== undefined) {
    const parsed = parseExplicitWhen(explicit, "due", params.now, params.timezone);
    if (parsed.error) return { error: parsed.error };
    return { at: parsed.value!.at };
  }
  return { at: defaultReviewAt(params.now, params.days, params.timezone) };
}

/**
 * Validates and derives everything a decision capture needs to write in its
 * one INSERT: tags, the review when_*, and the frozen label. Returns an
 * error for any rule in validateDecisionCapture or a bad confidence; nothing
 * is written on either.
 */
export function buildDecisionCapture(
  input: DecisionCaptureInput,
  content: string,
  now: number,
  cfg: DecisionCaptureConfig,
): DecisionCaptureResult | { error: string } {
  const validation = validateDecisionCapture(input);
  if (validation) return validation;

  const tags = [LEDGER_DECISION_TAG];
  let confidence: DecisionCaptureResult["confidence"];
  if (input.confidence !== undefined) {
    const rounded = roundConfidence(input.confidence);
    if ("error" in rounded) return rounded;
    const source: ConfidenceSource = input.confidence_source ?? "inferred";
    tags.push(`${CONFIDENCE_TAG_PREFIX}${rounded.value.toFixed(2)}`);
    tags.push(`${CONFIDENCE_SOURCE_TAG_PREFIX}${source}`);
    confidence = { ...rounded, source };
  }

  const review = computeReviewAt({
    review_by: input.review_by,
    when: input.when,
    now,
    timezone: cfg.timezone,
    days: cfg.reviewDefaultDays,
  });
  if ("error" in review) return { error: `${review.error}. Nothing was saved.` };

  return {
    tags,
    when_at: review.at,
    when_kind: "due",
    when_source: "explicit",
    // Bare short decision, no "Review:" prefix (18-copy-deck.md section 5,
    // "Italian on the Due sheet"): the ledger:decision tag already marks the
    // row as a decision review, so every reader adds its own localized
    // prefix instead of showing this stored English one unchanged. See
    // reviewLabel's comment above and src/push/send.ts, the one current
    // reader that needs the English form.
    when_label: shortDecision(content),
    confidence,
  };
}
