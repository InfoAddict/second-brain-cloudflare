import { describe, it, expect } from "vitest";
import { isFtsFailure, repairFtsIndex } from "../../src/db/fts-repair";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";

const err = (message: string) => new Error(message);

describe("isFtsFailure", () => {
  it("matches the entries_fts table missing", () => {
    expect(isFtsFailure(err("D1_ERROR: no such table: entries_fts: SQLITE_ERROR"))).toBe(true);
  });

  // B1(b) narrowed this: "may not be modified/dropped" is what SQLite says
  // when something tries to touch an FTS5 shadow table directly — a
  // protection error, not a corruption signal. Production code never issues
  // such a statement, and treating it as repairable would be another false
  // positive of the same shape as the "no such column" one below.
  it("does not match a shadow table's own protection error", () => {
    for (const shadow of ["entries_fts_data", "entries_fts_idx", "entries_fts_docsize", "entries_fts_config", "entries_fts_content"]) {
      expect(isFtsFailure(err(`table ${shadow} may not be modified`))).toBe(false);
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

  // B1(b): only errors that genuinely mean the index is missing or broken.
  // A read that merely names a nonexistent entries_fts COLUMN, or an FTS5
  // query-syntax/constraint/limit error, means the caller's SQL is wrong —
  // not that the index needs rebuilding. Observed for real against
  // node:sqlite (see the fix's report for exactly how each was produced).
  it("does not match a malformed read naming an entries_fts column", () => {
    expect(isFtsFailure(err("no such column: entries_fts.nonexistent"))).toBe(false);
  });

  it("does not match FTS5 MATCH syntax errors", () => {
    expect(isFtsFailure(err("unterminated string"))).toBe(false);
    expect(isFtsFailure(err('fts5: syntax error near ""'))).toBe(false);
  });

  it("does not match a duplicate-rowid constraint failure", () => {
    expect(isFtsFailure(err("constraint failed"))).toBe(false);
  });

  it("does not match a bound-variable-limit error", () => {
    expect(isFtsFailure(err("variable number must be between ?1 and ?32766"))).toBe(false);
  });

  it("matches a malformed database disk image", () => {
    expect(isFtsFailure(err("database disk image is malformed"))).toBe(true);
  });

  it("matches FTS5 corruption wording", () => {
    expect(isFtsFailure(err('fts5: corruption on page 1, segment 16, table "entries_fts"'))).toBe(true);
  });

  it("matches a vtable constructor failure", () => {
    expect(isFtsFailure(err("vtable constructor failed: entries_fts"))).toBe(true);
  });

  it("matches SQLITE_CORRUPT_VTAB by name", () => {
    expect(isFtsFailure(err("SQLITE_CORRUPT_VTAB"))).toBe(true);
  });
});

function ftsRowCount(s: SqliteD1): Promise<number> {
  return s.db.prepare("SELECT count(*) AS n FROM entries_fts").first()
    .then(row => (row as { n: number }).n);
}

function ftsObjectCount(s: SqliteD1): Promise<number> {
  return s.db.prepare(
    `SELECT count(*) AS n FROM sqlite_master WHERE name IN ('entries_fts','entries_fts_insert','entries_fts_update','entries_fts_delete')`,
  ).first().then(row => (row as { n: number }).n);
}

function envFor(s: SqliteD1, kv: ReturnType<typeof makeMemoryKV> = makeMemoryKV()): Env {
  return makeTestEnv(undefined, { DB: s.db as unknown as D1Database, OAUTH_KV: kv });
}

describe("repairFtsIndex health check before a destructive rebuild (B1c)", () => {
  it("leaves a healthy index untouched and returns false", async () => {
    const s = makeSqliteD1();
    try {
      s.seed({ id: "e1", content: "healthy dashboard entry", createdAt: 1 });
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");
      await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "42");
      const repaired = await repairFtsIndex(envFor(s, kv));

      expect(repaired).toBe(false);
      expect(await ftsRowCount(s)).toBe(1);
      expect(await kv.get(FTS_READY_KV_KEY)).toBe("1");
      expect(await kv.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("42");
    } finally { s.close(); }
  });

  it("creates a missing table without dropping anything first", async () => {
    const s = makeSqliteD1();
    try {
      s.seed({ id: "e1", content: "will be reindexed", createdAt: 1 });
      await s.db.exec(
        "DROP TRIGGER IF EXISTS entries_fts_insert; DROP TRIGGER IF EXISTS entries_fts_update;" +
        "DROP TRIGGER IF EXISTS entries_fts_delete; DROP TABLE IF EXISTS entries_fts;",
      );
      s.issued.length = 0;
      const repaired = await repairFtsIndex(envFor(s));

      expect(repaired).toBe(true);
      expect(await ftsObjectCount(s)).toBe(4);
      // No drop statement is issued when the table was never there.
      expect(s.issued.some(sql => /^DROP/i.test(sql))).toBe(false);
    } finally { s.close(); }
  });

  it("drops and rebuilds a broken (wrong-shaped) existing table", async () => {
    const s = makeSqliteD1();
    try {
      await s.db.exec("DROP TABLE entries_fts");
      await s.db.exec("CREATE TABLE entries_fts (wrong_col TEXT)");
      const repaired = await repairFtsIndex(envFor(s));

      expect(repaired).toBe(true);
      expect(await ftsObjectCount(s)).toBe(4);
      expect(await ftsRowCount(s)).toBe(0);
    } finally { s.close(); }
  });
});

describe("repairFtsIndex fixes KV before touching the table (B2)", () => {
  it("clears the ready cache, deletes the flag, and resets the cursor before any DDL", async () => {
    const s = makeSqliteD1();
    try {
      await s.db.exec("DROP TABLE entries_fts");
      const order: string[] = [];
      const kv = makeMemoryKV();
      const realDelete = kv.delete.bind(kv);
      const realPut = kv.put.bind(kv);
      const spyKv = {
        ...kv,
        delete: async (key: string) => { order.push(`kv:delete:${key}`); return realDelete(key); },
        put: async (key: string, value: string) => { order.push(`kv:put:${key}`); return realPut(key, value); },
      } as unknown as KVNamespace;
      const env = { ...envFor(s, kv), OAUTH_KV: spyKv } as Env;
      const rawPrepare = (env.DB as D1Database).prepare.bind(env.DB);
      (env.DB as unknown as { prepare: typeof rawPrepare }).prepare = (sql: string) => {
        if (/^CREATE|^DROP/i.test(sql.trim())) order.push(`ddl:${sql.trim().slice(0, 12)}`);
        return rawPrepare(sql);
      };

      await repairFtsIndex(env);

      const ddlIndex = order.findIndex(x => x.startsWith("ddl:"));
      const kvIndexes = order.map((x, i) => x.startsWith("kv:") ? i : -1).filter(i => i >= 0);
      expect(kvIndexes.length).toBeGreaterThan(0);
      expect(Math.max(...kvIndexes)).toBeLessThan(ddlIndex);
      expect(order.filter(x => x.startsWith("kv:"))).toEqual([
        `kv:delete:${FTS_READY_KV_KEY}`,
        `kv:put:${FTS_BACKFILL_CURSOR_KV_KEY}`,
      ]);
    } finally { s.close(); }
  });

  it("aborts without touching the table when a KV op fails, and rethrows that failure", async () => {
    const s = makeSqliteD1();
    try {
      s.seed({ id: "old", content: "old searchable", createdAt: 1 });
      await s.db.exec("DROP TABLE entries_fts");
      const innerKv = makeMemoryKV();
      await innerKv.put(FTS_READY_KV_KEY, "1");
      await innerKv.put(FTS_BACKFILL_CURSOR_KV_KEY, "100");
      const kv = {
        get: innerKv.get.bind(innerKv),
        put: innerKv.put.bind(innerKv),
        delete: async () => { throw new Error("KV unavailable"); },
      } as unknown as KVNamespace;

      await expect(repairFtsIndex(envFor(s, kv as never))).rejects.toThrow("KV unavailable");

      expect(await innerKv.get(FTS_READY_KV_KEY)).toBe("1");
      expect(await innerKv.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("100");
      expect(s.rows().map(r => r.id)).toEqual(["old"]);
      // The table was never touched: it is still missing, not recreated empty.
      const objects = await s.db.prepare(
        `SELECT name FROM sqlite_master WHERE name = 'entries_fts'`,
      ).all() as { results: { name: string }[] };
      expect(objects.results).toEqual([]);
    } finally { s.close(); }
  });
});

describe("repairFtsIndex coalesces concurrent repairs within an isolate (S1)", () => {
  it("both concurrent writes persist once and both land in entries_fts", async () => {
    const s = makeSqliteD1();
    try {
      await s.db.exec("DROP TABLE entries_fts");
      let repairCalls = 0;
      const env = envFor(s);
      const rawBatch = (env.DB as D1Database).batch.bind(env.DB);
      (env.DB as unknown as { batch: typeof rawBatch }).batch = (stmts: D1PreparedStatement[]) => {
        if (stmts.length >= 4) repairCalls++;
        return rawBatch(stmts);
      };

      const sql = "INSERT INTO entries (id, content, tags, source, created_at) VALUES (?, ?, '[]', 'api', 1)";
      const attempt = async (id: string, content: string) => {
        try {
          await env.DB.prepare(sql).bind(id, content).run();
        } catch {
          const repaired = await repairFtsIndex(env);
          if (repaired) await env.DB.prepare(sql).bind(id, content).run();
        }
      };
      await Promise.all([attempt("a", "one searchable"), attempt("b", "two searchable")]);

      const entries = (await s.db.prepare("SELECT id FROM entries ORDER BY id").all() as { results: { id: string }[] }).results.map(r => r.id);
      const fts = (await s.db.prepare("SELECT id FROM entries_fts ORDER BY id").all() as { results: { id: string }[] }).results.map(r => r.id);
      expect(entries).toEqual(["a", "b"]);
      expect(fts).toEqual(["a", "b"]);
      expect(repairCalls).toBe(1);
    } finally { s.close(); }
  });
});
