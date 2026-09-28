/**
 * The read-side validity contract every entries-returning surface shares
 * (T-0089.2.1; spec 14 5.9): the same six fields on GET /recall, GET /list,
 * GET /entry, and the MCP get/list_recent/recall text. One function so the
 * four surfaces cannot drift on what "replaced" or "true since" mean.
 */
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

const isDeprecatedTag = (tag: string) => tag.toLowerCase() === "status:deprecated";

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
  const validFromStated = row.validFrom !== null && row.validFrom !== undefined;
  const validUntil = row.validUntil ?? null;
  const supersededBy = row.supersededBy ?? null;
  const wrong = row.tags.some(isDeprecatedTag);
  const validityState: ValidityState =
    wrong ? "wrong" :
    validUntil !== null ? (supersededBy ? "replaced" : "ended") :
    "current";
  return {
    validFrom: validFromStated ? (row.validFrom as number) : row.createdAt,
    validFromStated,
    validUntil,
    validityState,
    supersededBy,
    retractedSource: row.tags.includes("retracted-source"),
  };
}
