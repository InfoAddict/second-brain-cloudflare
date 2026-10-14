import { afterAll, describe, expect, it } from "vitest";
import { makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

// Guard: the cold-start schema probe must fit workerd's D1 limits (5 compound terms, 100 binds).
const MAX_TERMS = 5;
const MAX_BINDS = 100;

/** Drops string literals, quoted identifiers and comments so operator words and '?' inside them are not counted. */
function stripQuoted(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, "``");
}

/** Compound terms = every UNION / INTERSECT / EXCEPT (UNION ALL once) plus one. */
function countTerms(sql: string): number {
  return (stripQuoted(sql).match(/\b(?:UNION|INTERSECT|EXCEPT)\b/gi) ?? []).length + 1;
}

function countPlaceholders(sql: string): number {
  return (stripQuoted(sql).match(/\?/g) ?? []).length;
}

function assertWithinLimits(sql: string, binds: unknown[]): void {
  const terms = countTerms(sql);
  if (terms > MAX_TERMS) throw new Error(`schema probe has ${terms} compound terms, workerd allows ${MAX_TERMS}`);
  if (binds.length > MAX_BINDS) throw new Error(`schema probe has ${binds.length} bound values, workerd allows ${MAX_BINDS}`);
}

interface Recorded { sql: string; binds: unknown[] }

/** Wraps a D1 so every prepared statement and its bind() values are logged, bind or no bind. */
function recordD1(real: any, log: Recorded[]): D1Database {
  const wrapStmt = (stmt: any, rec: Recorded): any =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") {
          return (...args: unknown[]) => {
            rec.binds = args;
            return wrapStmt(target.bind(...args), rec);
          };
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const rec: Recorded = { sql, binds: [] };
          log.push(rec);
          return wrapStmt(target.prepare(sql), rec);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

async function captureProbe() {
  const { initializeDatabase, resetDatabaseInit } = await import("../../src/db/init");
  const sqlite = makeSqliteD1();
  const log: Recorded[] = [];
  resetDatabaseInit();
  await initializeDatabase(makeTestEnv(recordD1(sqlite.db, log) as any));
  resetDatabaseInit();
  const probes = log.filter(r => r.sql.includes("sqlite_master") && r.sql.includes("pragma_table_info"));
  return { sqlite, probes, all: log };
}

const OLD_PROBE_4_0_0 =
  `SELECT type AS kind, name, sql AS definition FROM sqlite_master WHERE type IN ('table','index','trigger') ` +
  `UNION ALL SELECT 'column' AS kind, name, NULL AS definition FROM pragma_table_info('entries')` +
  `UNION ALL SELECT 'edge_column' AS kind, name, NULL AS definition FROM pragma_table_info('edges')` +
  `UNION ALL SELECT 'user_column' AS kind, name, NULL AS definition FROM pragma_table_info('users')` +
  `UNION ALL SELECT 'admin_event_column' AS kind, name, NULL AS definition FROM pragma_table_info('admin_events')` +
  `UNION ALL SELECT 'entry_version_column' AS kind, name, NULL AS definition FROM pragma_table_info('entry_versions')` +
  `UNION ALL SELECT 'entries_trash_column' AS kind, name, NULL AS definition FROM pragma_table_info('entries_trash')`;

const PR_SHAPED_PROBE =
  `WITH probe(kind, tbl) AS (VALUES (?, ?),(?, ?)), ` +
  `columns AS (SELECT p.kind AS kind, ti.name AS name FROM probe p CROSS JOIN pragma_table_info(p.tbl) ti) ` +
  `SELECT type AS kind, name, sql AS definition FROM sqlite_master WHERE type IN ('table','index','trigger') ` +
  `UNION ALL ` +
  `SELECT kind, name, NULL AS definition FROM columns`;

const sqliteHandles: { close(): void }[] = [];
afterAll(() => { for (const s of sqliteHandles) s.close(); });

async function probe() {
  const c = await captureProbe();
  sqliteHandles.push(c.sqlite);
  return c;
}

describe("schema probe limits", () => {
  it("[CP2-T01] the real probe stays within workerd's 5 compound terms", async () => {
    const { probes } = await probe();
    expect(probes).toHaveLength(1);
    const terms = countTerms(probes[0].sql);
    if (terms > MAX_TERMS) throw new Error(`schema probe has ${terms} compound terms, workerd allows ${MAX_TERMS}`);
    expect(terms).toBe(2);
  });

  it("[CP2-T02] the real probe stays within 100 bound values and placeholders match binds", async () => {
    const { probes } = await probe();
    expect(probes).toHaveLength(1);
    const placeholders = countPlaceholders(probes[0].sql);
    expect(probes[0].binds.length).toBeLessThanOrEqual(MAX_BINDS);
    expect(probes[0].binds).toHaveLength(12);
    expect(placeholders).toBe(12);
  });

  it("[CP2-T03] the guard really saw the probe", async () => {
    const { probes } = await probe();
    expect(probes).toHaveLength(1);
    expect(typeof probes[0].sql).toBe("string");
    expect(probes[0].sql).toContain("sqlite_master");
    expect(probes[0].sql).toContain("pragma_table_info");
  });

  it("[CP2-T04] the captured probe still answers its question on a real SQLite database", async () => {
    const { probes, sqlite } = await probe();
    expect(probes).toHaveLength(1);
    const res = await (sqlite.db as any).prepare(probes[0].sql).bind(...probes[0].binds).all();
    const rows = res.results as { kind: string; name: string }[];
    expect(rows).toContainEqual(expect.objectContaining({ kind: "table", name: "entries" }));
    expect(rows).toContainEqual(expect.objectContaining({ kind: "column", name: "content" }));
    expect(rows).toContainEqual(expect.objectContaining({ kind: "edge_column" }));
  });

  it("[CP2-T05] counter reads the 4.0.0 probe as 7 terms", () => {
    expect(countTerms(OLD_PROBE_4_0_0)).toBe(7);
    expect(() => assertWithinLimits(OLD_PROBE_4_0_0, [])).toThrow("schema probe has 7 compound terms, workerd allows 5");
  });

  it("[CP2-T06] counter reads the PR-shaped probe as 2 terms", () => {
    expect(countTerms(PR_SHAPED_PROBE)).toBe(2);
    expect(countPlaceholders(PR_SHAPED_PROBE)).toBe(4);
  });

  it("[CP2-T07] counter counts every compound operator", () => {
    expect(countTerms("SELECT 1 UNION SELECT 2")).toBe(2);
    expect(countTerms("SELECT 1 INTERSECT SELECT 2")).toBe(2);
    expect(countTerms("SELECT 1 EXCEPT SELECT 2")).toBe(2);
    expect(countTerms("select 1 union all select 2")).toBe(2);
    expect(countTerms("SELECT 1\nUNION\nSELECT 2\nUNION\nSELECT 3\nUNION\nSELECT 4\nUNION\nSELECT 5\nUNION\nSELECT 6")).toBe(6);
    expect(countTerms("SELECT 1")).toBe(1);
  });

  it("[CP2-T08] counter ignores operator words inside quoted text and comments", () => {
    expect(countTerms("SELECT 'a UNION ALL b'")).toBe(1);
    expect(countTerms('SELECT 1 AS "UNION"')).toBe(1);
    expect(countTerms("SELECT 1 -- UNION ALL x")).toBe(1);
    expect(countTerms("SELECT 1 /* EXCEPT */")).toBe(1);
  });

  it("[CP2-T09] placeholder counter ignores question marks inside quoted text", () => {
    expect(countPlaceholders("SELECT '?', ? FROM t")).toBe(1);
    expect(countPlaceholders('SELECT "?", ?, ? FROM t')).toBe(2);
  });

  it("[CP2-T10] the limit check itself fails when it should", () => {
    const five = "SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5";
    const six = `${five} UNION SELECT 6`;
    expect(() => assertWithinLimits(five, new Array(100).fill(1))).not.toThrow();
    expect(() => assertWithinLimits(six, [])).toThrow("schema probe has 6 compound terms, workerd allows 5");
    expect(() => assertWithinLimits(five, new Array(101).fill(1))).toThrow("schema probe has 101 bound values, workerd allows 100");
  });
});

describe("schema probe limits, proven guard", () => {
  it("[CP2-X01] the both-ways-proven limit check passes on the real captured probe", async () => {
    const { probes } = await probe();
    expect(probes).toHaveLength(1);
    expect(() => assertWithinLimits(probes[0].sql, probes[0].binds)).not.toThrow();
  });
});
