import { describe, it, expect } from "vitest";
import { isFtsFailure } from "../../src/db/fts-repair";

const err = (message: string) => new Error(message);

describe("isFtsFailure", () => {
  it("matches the entries_fts table missing", () => {
    expect(isFtsFailure(err("D1_ERROR: no such table: entries_fts: SQLITE_ERROR"))).toBe(true);
  });

  it("matches each FTS5 shadow table by name", () => {
    for (const shadow of ["entries_fts_data", "entries_fts_idx", "entries_fts_docsize", "entries_fts_config", "entries_fts_content"]) {
      expect(isFtsFailure(err(`table ${shadow} may not be modified`))).toBe(true);
    }
  });

  it("matches a broken table's shape mismatch", () => {
    expect(isFtsFailure(err("table entries_fts has no column named id"))).toBe(true);
  });

  it("matches a plain string thrown instead of an Error", () => {
    expect(isFtsFailure("no such table: entries_fts")).toBe(true);
  });

  it("does not match an unrelated SQLITE_ERROR", () => {
    expect(isFtsFailure(err("D1_ERROR: no such table: entries: SQLITE_ERROR"))).toBe(false);
  });

  it("does not match a UNIQUE constraint failure", () => {
    expect(isFtsFailure(err("UNIQUE constraint failed: users.email"))).toBe(false);
  });

  it("does not match an unrelated table whose name merely contains 'entries'", () => {
    expect(isFtsFailure(err("no such table: entry_events"))).toBe(false);
  });

  it("does not match null or undefined", () => {
    expect(isFtsFailure(null)).toBe(false);
    expect(isFtsFailure(undefined)).toBe(false);
  });
});
