import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ENTRY_INSERT_COLUMNS,
  ENTRY_INSERT_SQL,
  formatDbError,
  isImportRecordObject,
  parseImportLimit,
  parseRequiredString,
  parseTags,
} from "../../src/entries/import";

const repoRoot = resolve(import.meta.dirname, "../..");

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

function parseColumnList(body: string): string[] {
  const cols: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of body) {
    if (ch === "'") inQuote = !inQuote;
    if (ch === "," && !inQuote) {
      const name = current.trim().split(/\s+/)[0];
      if (name && !name.startsWith("UNIQUE")) cols.push(name);
      current = "";
    } else {
      current += ch;
    }
  }
  const name = current.trim().split(/\s+/)[0];
  if (name && !name.startsWith("UNIQUE")) cols.push(name);
  return cols;
}

function parseCreateTableColumns(sql: string, table: string): string[] {
  const cleaned = stripSqlComments(sql);
  const match = cleaned.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([^)]*)\\)`, "i"));
  if (!match) return [];
  return parseColumnList(match[1]);
}

function parseAlterColumns(initSource: string, table: string): string[] {
  const cols: string[] = [];
  const re = new RegExp(`ALTER TABLE ${table} ADD COLUMN (\\w+)`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(initSource)) !== null) {
    cols.push(m[1]);
  }
  return cols;
}

describe("import helpers", () => {
  it("ENTRY_INSERT_COLUMNS are a subset of schema.sql and init.ts columns", () => {
    const schemaSql = readFileSync(resolve(repoRoot, "db/schema.sql"), "utf-8");
    const initTs = readFileSync(resolve(repoRoot, "src/db/init.ts"), "utf-8");

    const schemaCols = parseCreateTableColumns(schemaSql, "entries");
    const initCols = [
      ...parseCreateTableColumns(initTs, "entries"),
      ...parseAlterColumns(initTs, "entries"),
    ];

    for (const col of ENTRY_INSERT_COLUMNS) {
      expect(schemaCols, `missing ${col} in schema.sql`).toContain(col);
      expect(initCols, `missing ${col} in init.ts`).toContain(col);
    }

    expect(ENTRY_INSERT_SQL).toContain("INSERT INTO entries (");
    expect(ENTRY_INSERT_SQL).not.toContain("updated_at");
  });

  it("parseRequiredString rejects non-string values without throwing", () => {
    expect(parseRequiredString(42, "missing_id", "invalid_id")).toEqual({ ok: false, reason: "invalid_id" });
    expect(parseRequiredString("  abc  ", "missing_id", "invalid_id")).toEqual({ ok: true, value: "abc" });
  });

  it("parseTags rejects non-string tag values", () => {
    expect(parseTags([42])).toEqual({ ok: false, reason: "invalid_tag" });
    expect(parseTags(["work", "kind:semantic"])).toEqual({ ok: true, tags: ["work", "kind:semantic"] });
    expect(parseTags(undefined)).toEqual({ ok: true, tags: [] });
  });

  it("isImportRecordObject rejects null and arrays", () => {
    expect(isImportRecordObject(null)).toBe(false);
    expect(isImportRecordObject([])).toBe(false);
    expect(isImportRecordObject({ id: "x" })).toBe(true);
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
