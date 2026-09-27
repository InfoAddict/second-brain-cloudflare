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
  reason?: "the ledger's minimum" | "the ledger's maximum";
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
    return { error: "confidence and review_by are only for decisions (decision: true)." };
  }
  if (!input.decision) return null;

  if (input.standing || input.owed_by !== undefined || input.owed_to !== undefined) {
    return { error: "A decision can't also be a standing instruction or a commitment." };
  }
  if (input.review_by !== undefined && input.when !== undefined) {
    return { error: "Use review_by for a decision's review date." };
  }
  if (input.when_kind !== undefined && input.when_kind !== "due") {
    return { error: "A decision's review date is always due." };
  }
  return null;
}

/** Clamped to [0.05, 0.95] and rounded to the nearest 0.05. 0 and anything over 1 are errors. */
export function roundConfidence(raw: number): ConfidenceResult | { error: string } {
  if (!(raw > 0) || raw > 1) {
    return { error: "confidence must be greater than 0 and at most 1" };
  }
  const clamped = Math.min(0.95, Math.max(0.05, raw));
  const value = Math.round(clamped * 20) / 20;
  if (raw > 0.95) return { value, reason: "the ledger's maximum" };
  if (raw < 0.05) return { value, reason: "the ledger's minimum" };
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

export function reviewLabel(content: string): string {
  return `Review: ${shortDecision(content)}`;
}

/** now + days days, at 09:00 in timezone — the calendar date is taken from the approximate instant, then re-anchored at 09:00 in that zone. */
function defaultReviewAt(now: number, days: number, timezone: string): number {
  const approx = now + days * 86400000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(approx);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return zonedTimeMs(get("year"), get("month") - 1, get("day"), 9, 0, 0, timezone);
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
  if ("error" in review) return review;

  return {
    tags,
    when_at: review.at,
    when_kind: "due",
    when_source: "explicit",
    when_label: reviewLabel(content),
    confidence,
  };
}
