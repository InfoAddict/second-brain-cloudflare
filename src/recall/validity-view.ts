/**
 * The read-side validity contract every entries-returning surface shares
 * (T-0089.2.1; spec 14 5.9): the same six fields on GET /recall, GET /list,
 * GET /entry, and the MCP get/list_recent/recall text. One function so the
 * four surfaces cannot drift on what "replaced" or "true since" mean.
 */
import { RETRACTED_SOURCE_TAG, UNKNOWN_START } from "../memory/validity";
import { getStatus } from "../memory/status";

export type ValidityState = "current" | "replaced" | "ended" | "wrong";

export interface SupersededBy {
  id: string;
  preview: string;
}

export interface ValiditySummary {
  /** Effective start: COALESCE(valid_from, created_at). */
  validFrom: number;
  /** Whether valid_from was stated, not defaulted from created_at. */
  validFromStated: boolean;
  validUntil: number | null;
  validityState: ValidityState;
  /** The live closer, when validityState is "replaced"; null otherwise. */
  supersededBy: SupersededBy | null;
  retractedSource: boolean;
}

/** Parses the raw `superseded_by_json` column (5.9's correlated subquery), tolerating its absence. */
export function parseSupersededBy(raw: string | null | undefined): SupersededBy | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; preview?: unknown };
    if (typeof parsed.id !== "string") return null;
    return { id: parsed.id, preview: typeof parsed.preview === "string" ? parsed.preview : "" };
  } catch {
    return null;
  }
}

export function validitySummary(row: {
  createdAt: number;
  validFrom?: number | null;
  validUntil?: number | null;
  tags: readonly string[];
  supersededBy?: SupersededBy | null;
}): ValiditySummary {
  // COALESCE(valid_from, created_at): only a NULL valid_from falls back.
  // UNKNOWN_START (0) is itself a stated column value ("true from before
  // any date this brain has", from an end-only fact) — real, but not a
  // date worth rendering as a start, so validFromStated is false for it too.
  const hasStatedFrom = row.validFrom !== null && row.validFrom !== undefined;
  const validFromStated = hasStatedFrom && row.validFrom !== UNKNOWN_START;
  const validUntil = row.validUntil ?? null;
  const supersededBy = row.supersededBy ?? null;
  const wrong = getStatus(row.tags as string[]) === "deprecated";
  const validityState: ValidityState =
    wrong ? "wrong" :
    validUntil !== null ? (supersededBy ? "replaced" : "ended") :
    "current";
  return {
    validFrom: hasStatedFrom ? (row.validFrom as number) : row.createdAt,
    validFromStated,
    validUntil,
    validityState,
    supersededBy,
    retractedSource: row.tags.includes(RETRACTED_SOURCE_TAG),
  };
}
