import { describe, it, expect } from "vitest";
import {
  ENTRY_INSERT_COLUMNS,
  ENTRY_INSERT_SQL,
  formatDbError,
  parseImportLimit,
  parseRequiredString,
} from "../../src/entries/import";

describe("import helpers", () => {
  it("ENTRY_INSERT_SQL columns match main schema (no updated_at until #263)", () => {
    expect(ENTRY_INSERT_COLUMNS).toEqual([
      "id",
      "content",
      "tags",
      "source",
      "created_at",
      "vector_ids",
      "recall_count",
      "importance_score",
      "contradiction_wins",
      "contradiction_losses",
    ]);
    expect(ENTRY_INSERT_SQL).toContain("INSERT INTO entries (");
    expect(ENTRY_INSERT_SQL).not.toContain("updated_at");
  });

  it("parseRequiredString rejects non-string values without throwing", () => {
    expect(parseRequiredString(42, "missing_id", "invalid_id")).toEqual({ ok: false, reason: "invalid_id" });
    expect(parseRequiredString("  abc  ", "missing_id", "invalid_id")).toEqual({ ok: true, value: "abc" });
  });

  it("parseImportLimit clamps invalid and oversized values", () => {
    expect(parseImportLimit(null)).toBe(100);
    expect(parseImportLimit("0")).toBe(100);
    expect(parseImportLimit("50")).toBe(50);
    expect(parseImportLimit("99999")).toBe(1000);
  });

  it("formatDbError truncates long messages", () => {
    const long = "x".repeat(300);
    expect(formatDbError(new Error(long)).length).toBe(200);
  });
});
