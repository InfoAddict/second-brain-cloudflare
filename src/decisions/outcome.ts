/**
 * Decision outcome resolution (Design 4.2): the tag/when transition and the exact reply
 * for `resolve(id, "outcome", result, note?)` and `POST /decisions/outcome`. Pure: no D1,
 * no clock of its own — the caller (src/memory/actions.ts) reads the row, calls this, and
 * writes the CAS batch.
 */
import { LEDGER_TAG, OUTCOME_TAG_PREFIX, REVIEW_REARMS_TAG_PREFIX } from "../tags/t7";
import { shortDecision } from "./capture";
import { formatMonthDayYear } from "../capture/t7-capture";

export type DecisionOutcomeResult = "right" | "wrong" | "mixed" | "unknown";

export interface OutcomeUpdate {
  nextTags: string[];
  nextWhen: { when_at: number | null; when_kind: string | null; when_source: string | null };
  /** The reply when no note was given, or the note appended without incident. */
  reply: string;
}

/** True when the row carries the ledger:decision marker — the outcome/received/stop_standing precondition. */
export const isLedgerDecision = (tags: readonly string[]): boolean => tags.includes(LEDGER_TAG);

const rearmsOf = (tags: readonly string[]): number => {
  const tag = tags.find(t => t.startsWith(REVIEW_REARMS_TAG_PREFIX));
  const n = tag ? Number(tag.slice(REVIEW_REARMS_TAG_PREFIX.length)) : 0;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Builds the next tags, next when_*, and the reply for one outcome (Design 4.2). `content` is
 * the decision's own stored text, used only for `shortDecision` in the reply subject.
 */
export function buildOutcomeUpdate(
  currentTags: readonly string[], result: DecisionOutcomeResult, content: string, now: number,
  cfg: { reviewDefaultDays: number; timezone: string },
): OutcomeUpdate {
  const withoutOutcomeAndRearms = currentTags.filter(t => !t.startsWith(OUTCOME_TAG_PREFIX) && !t.startsWith(REVIEW_REARMS_TAG_PREFIX));

  if (result !== "unknown") {
    return {
      nextTags: [...withoutOutcomeAndRearms, `${OUTCOME_TAG_PREFIX}${result}`],
      nextWhen: { when_at: null, when_kind: null, when_source: "cleared" },
      reply: `Recorded: ${shortDecision(content)} went ${result}. Undo is available.`,
    };
  }

  const n = rearmsOf(currentTags);
  if (n < 2) {
    const at = now + cfg.reviewDefaultDays * 86400000;
    return {
      nextTags: [...withoutOutcomeAndRearms, `${OUTCOME_TAG_PREFIX}unknown`, `${REVIEW_REARMS_TAG_PREFIX}${n + 1}`],
      nextWhen: { when_at: at, when_kind: "due", when_source: "explicit" },
      reply: `OK, I'll ask again around ${formatMonthDayYear(at, cfg.timezone)}.`,
    };
  }
  return {
    nextTags: [...withoutOutcomeAndRearms, `${OUTCOME_TAG_PREFIX}unknown`],
    nextWhen: { when_at: null, when_kind: null, when_source: "cleared" },
    reply: "OK, no more reviews for this one.",
  };
}

/**
 * "Outcome (2026-09-27): right. Shipped the redesign early." (Design 4.2) — passed as the
 * `addition` to src/capture/store.ts's appendToEntry, which supplies its own dated
 * "[Update <date>]: " wrapper and versioning; this is the text inside that wrapper.
 */
export function outcomeNoteText(result: DecisionOutcomeResult, note: string, now: number): string {
  const date = new Date(now).toISOString().slice(0, 10);
  return `Outcome (${date}): ${result}. ${note}`;
}
