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
const OUTCOME_TAG_PREFIX = "outcome:";
const OUTCOME_VALUES: ReadonlySet<string> = new Set<DecisionOutcome>(["right", "wrong", "mixed", "unknown"]);

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
 * Collapses a "<col> IN (?, ?, ...)" scope clause into one json_each
 * binding. A member of many company teams (scopeWhere returns one binding
 * per readable workspace) combined with decisionsActionable's own two
 * bindings can otherwise exceed D1's 100 bound-parameter limit per
 * statement — 99 teams is already 99 + 1 (personal) + 2 (actionable) = 102.
 * Any other clause shape (a single teamId "= ?" scope, already one binding)
 * passes through unchanged.
 */
function boundedScope(scope: ScopeClause): ScopeClause {
  const match = scope.clause.match(/^(\w+) IN \(\?(?:,\s*\?)*\)$/);
  if (!match || scope.bindings.length <= 1) return scope;
  return { clause: `${match[1]} IN (SELECT value FROM json_each(?))`, bindings: [JSON.stringify(scope.bindings)] };
}

/**
 * Every resolved (outcome:*) decision the caller can score, capped at 500
 * rows — reads only idx_entries_ledger rows (C14). Genuinely scored rows
 * (right/wrong/mixed) sort before outcome:unknown ones regardless of age, so
 * unknown rows — which can arrive in bulk and skew much younger — never
 * crowd older scored decisions out of the cap; within each group, newest
 * first.
 */
export function calibrationQuery(scope: ScopeClause, actionable: ScopeClause): SqlWithBindings {
  // scope-checked: bounded rewrites scope's IN-list into a json_each form when it has more than one
  // binding; both shapes still scope by workspace_id, only the placeholder count changes.
  const bounded = boundedScope(scope);
  const sql = `SELECT tags FROM entries
    WHERE ${LEDGER_INDEXED} AND tags LIKE '%"outcome:%'
      AND tags NOT LIKE '%"status:deprecated"%'
      AND ${bounded.clause} AND ${actionable.clause}
    ORDER BY (tags LIKE '%"${OUTCOME_TAG_PREFIX}unknown"%') ASC, created_at DESC
    LIMIT 500`;
  return { sql, bindings: [...bounded.bindings, ...actionable.bindings] };
}

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
