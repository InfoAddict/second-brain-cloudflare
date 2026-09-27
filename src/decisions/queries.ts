/**
 * The calibration read: one statement, scoped by the read scope and by
 * "actionable" (design 4.3 / P7.7 — the caller's personal workspace, or any
 * workspace where they are the author, never a teammate's). Its row parser
 * feeds straight into calibration.ts's calibrate().
 */
import type { Identity } from "../lib/identity";
import type { ScopeClause } from "../lib/scope";
import { CONFIDENCE_TAG_PREFIX, CONFIDENCE_SOURCE_TAG_PREFIX, LEDGER_DECISION_TAG, type ConfidenceSource } from "./capture";
import type { DecisionOutcome, DecisionOutcomeRow } from "./calibration";

// Same instr(lower(tags), ...) shape idx_entries_ledger is defined on (Task 6,
// db/schema.sql / src/db/init.ts), so the read stays index-eligible once that
// index lands.
const LEDGER_INDEXED = `instr(lower(tags), '"${LEDGER_DECISION_TAG}"') > 0`;

export interface SqlWithBindings {
  sql: string;
  bindings: unknown[];
}

/**
 * Calibration is personal (P7.7, the brief's actionable rule, R
 * compute.ts:285-292): the caller's personal workspace, or a row they
 * authored anywhere — never a teammate's, even in a shared company
 * workspace. Duplicated rather than imported from brief/compute.ts, which
 * does not export its equivalent and is Track 1 / Lane C territory.
 */
export function decisionsActionable(auth: Identity): ScopeClause {
  return { clause: "(workspace_id IN (?, '') OR actor_id = ?)", bindings: [auth.personalWorkspaceId, auth.userId] };
}

/**
 * Every resolved (outcome:*) decision the caller can score, most recent
 * first, capped at 500 rows — reads only idx_entries_ledger rows (C14).
 */
export function calibrationQuery(scope: ScopeClause, actionable: ScopeClause): SqlWithBindings {
  const sql = `SELECT tags FROM entries
    WHERE ${LEDGER_INDEXED} AND tags LIKE '%"outcome:%'
      AND tags NOT LIKE '%"status:deprecated"%' AND ${scope.clause} AND ${actionable.clause}
    ORDER BY created_at DESC LIMIT 500`;
  return { sql, bindings: [...scope.bindings, ...actionable.bindings] };
}

const OUTCOME_TAG_PREFIX = "outcome:";
const OUTCOME_VALUES: ReadonlySet<string> = new Set<DecisionOutcome>(["right", "wrong", "mixed", "unknown"]);

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** A calibrationQuery row's tags column into calibrate()'s input shape. */
export function parseDecisionOutcomeRow(tagsJson: string): DecisionOutcomeRow {
  const tags = parseTags(tagsJson);
  let confidence: number | null = null;
  let source: ConfidenceSource | null = null;
  let outcome: DecisionOutcome | null = null;

  for (const tag of tags) {
    if (tag.startsWith(CONFIDENCE_TAG_PREFIX)) {
      const value = Number(tag.slice(CONFIDENCE_TAG_PREFIX.length));
      if (Number.isFinite(value)) confidence = value;
    } else if (tag.startsWith(CONFIDENCE_SOURCE_TAG_PREFIX)) {
      const value = tag.slice(CONFIDENCE_SOURCE_TAG_PREFIX.length);
      if (value === "stated" || value === "inferred") source = value;
    } else if (tag.startsWith(OUTCOME_TAG_PREFIX)) {
      const value = tag.slice(OUTCOME_TAG_PREFIX.length);
      if (OUTCOME_VALUES.has(value)) outcome = value as DecisionOutcome;
    }
  }
  return { confidence, source, outcome, tags };
}
