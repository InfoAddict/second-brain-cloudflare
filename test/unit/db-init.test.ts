import { describe, it, expect, beforeEach } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv } from "../helpers/make-env";

const MIGRATION: [column: string, alter: string][] = [
  ["recall_count", `ALTER TABLE entries ADD COLUMN recall_count INTEGER DEFAULT 0`],
  ["importance_score", `ALTER TABLE entries ADD COLUMN importance_score INTEGER DEFAULT 0`],
  ["contradiction_wins", `ALTER TABLE entries ADD COLUMN contradiction_wins INTEGER DEFAULT 0`],
  ["contradiction_losses", `ALTER TABLE entries ADD COLUMN contradiction_losses INTEGER DEFAULT 0`],
  ["updated_at", `ALTER TABLE entries ADD COLUMN updated_at INTEGER`],
  ["staleness_checked_at", `ALTER TABLE entries ADD COLUMN staleness_checked_at INTEGER`],
];
const ALL_COLUMNS = MIGRATION.map(([column]) => column);

type Row = { created_at: number; updated_at?: number | null };

// D1Mock's exec() never throws, so it cannot express "this column already exists".
// This stand-in models what the migration path turns on, verified against real workerd
// D1 via Miniflare: D1 rejects an ALTER for a column the table already has, and a column
// added to a populated table reads NULL on every pre-existing row. Every statement is
// recorded so a test can assert what a cold start costs — ALTERs are recorded even when
// they go on to throw.
function makeMigrationDb(existingColumns: string[] = [], rows: Row[] = []) {
  const columns = new Set(existingColumns);
  const execd: string[] = [];
  const prepared: string[] = [];

  const DB = {
    async exec(sql: string) {
      execd.push(sql);
      const added = sql.match(/ALTER TABLE entries ADD COLUMN (\w+)/);
      if (added) {
        if (columns.has(added[1])) throw new Error(`D1_EXEC_ERROR: duplicate column name: ${added[1]}`);
        columns.add(added[1]);
        if (added[1] === "updated_at") rows.forEach(r => { r.updated_at = null; });
      }
    },
    prepare(sql: string) {
      prepared.push(sql);
      const make = (args: unknown[]) => ({
        bind: (...next: unknown[]) => make(next),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      });
      return make([]);
    },
  } as unknown as D1Database;

  return { env: makeTestEnv(undefined, { DB }), execd, prepared, rows };
}

const rowsAged = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ created_at: 1000 + i }));
const touchesEntries = (statements: string[]) =>
  statements.filter(s => /\bentries\b/.test(s) && !/^(CREATE|ALTER)\b/.test(s));

describe("initializeDatabase updated_at migration", () => {
  // initializeDatabase memoises per isolate, so each case needs a clean slate.
  beforeEach(resetDatabaseInit);

  // updated_at is added by ALTER and never backfilled. initializeDatabase runs on every
  // cold isolate, so the target property is absolute: it issues no read and no write
  // against entries on any path, on any brain. A probe would be a full table scan on an
  // unindexed column (D1 bills rows_read); a backfill would be one row written per entry
  // (D1 caps rows written per day) for a value no reader can distinguish from NULL.

  it("issues no query at all on a fresh, unmigrated brain", async () => {
    const { env, execd, prepared, rows } = makeMigrationDb([], rowsAged(3));

    await initializeDatabase(env);

    expect(prepared).toEqual([]);
    expect(touchesEntries(execd)).toEqual([]);
    // The rows are left NULL on purpose — readers coalesce updated_at to created_at.
    expect(rows.every(r => r.updated_at === null)).toBe(true);
  });

  it("issues no query at all on an already-migrated brain", async () => {
    const { env, execd, prepared } = makeMigrationDb(ALL_COLUMNS, [{ created_at: 1000, updated_at: 1000 }]);

    await initializeDatabase(env);

    expect(prepared).toEqual([]);
    expect(touchesEntries(execd)).toEqual([]);
  });

  it("adds nothing on later cold starts", async () => {
    const { env, execd, prepared } = makeMigrationDb([], rowsAged(1));

    // Each reset stands in for a fresh isolate, which is what a cold start actually is.
    await initializeDatabase(env);
    const afterFirst = execd.length;
    resetDatabaseInit();
    await initializeDatabase(env);
    resetDatabaseInit();
    await initializeDatabase(env);

    expect(prepared).toEqual([]);
    expect(execd).toHaveLength(afterFirst * 3); // same DDL each time, nothing extra
    expect(touchesEntries(execd)).toEqual([]);
  });

  // All four nightly jobs await initializeDatabase inside one scheduled() invocation,
  // sharing a single subrequest budget. Without memoisation the DDL is paid for once per
  // job. Callers must still await real completion — ensureDbReady's waitUntil does not.
  describe("memoisation", () => {
    it("runs the schema work once per isolate no matter how many callers await it", async () => {
      const { env, execd } = makeMigrationDb([], rowsAged(1));

      await initializeDatabase(env);
      const once = execd.length;
      await Promise.all([initializeDatabase(env), initializeDatabase(env), initializeDatabase(env)]);

      expect(execd).toHaveLength(once);
    });

    it("shares one in-flight promise across concurrent callers", async () => {
      const { env, execd } = makeMigrationDb([], rowsAged(1));

      await Promise.all(Array.from({ length: 4 }, () => initializeDatabase(env)));

      expect(execd.filter(s => s.startsWith("CREATE TABLE IF NOT EXISTS entries"))).toHaveLength(1);
    });

    it("resetDatabaseInit clears the memo so a later call redoes the work", async () => {
      // Named for what it actually exercises — the test seam, not the failure path. The
      // rejection tests below are the ones that cover failure.
      const { env, execd } = makeMigrationDb([], rowsAged(1));

      await initializeDatabase(env);
      const once = execd.length;
      resetDatabaseInit();
      await initializeDatabase(env);

      expect(execd).toHaveLength(once * 2);
    });
  });

  // Regression: memoising on *completion* rather than on *success* latched a failed or
  // half-applied schema for the isolate's lifetime. Before memoisation each nightly job
  // re-ran the DDL and repaired the previous one's transient failure; these pin that a
  // failure is still retryable. Most likely trigger is a brand-new brain, where the very
  // first request must create every table against a D1 database made seconds earlier.
  describe("failure is not latched", () => {
    /** DB whose exec fails until `failing` is cleared. */
    function flakyDb() {
      const state = { failing: true, execd: [] as string[] };
      const DB = {
        async exec(sql: string) {
          if (state.failing) throw new Error("D1_ERROR: Network connection lost.");
          state.execd.push(sql);
        },
        prepare: () => { throw new Error("unexpected prepare"); },
      } as unknown as D1Database;
      return { state, env: makeTestEnv(undefined, { DB }) };
    }

    it("rejects rather than resolving when the schema could not be applied", async () => {
      const { env } = flakyDb();
      await expect(initializeDatabase(env)).rejects.toThrow(/Network connection lost/);
    });

    it("retries on the next call once D1 recovers", async () => {
      const { state, env } = flakyDb();

      await expect(initializeDatabase(env)).rejects.toThrow();
      state.failing = false;
      await initializeDatabase(env); // no resetDatabaseInit — the memo must have cleared itself

      expect(state.execd.filter(s => s.startsWith("CREATE TABLE IF NOT EXISTS entries"))).toHaveLength(1);
    });

    it("rejects when a later statement fails, rather than latching a partial schema", async () => {
      // The edges CREATE fails; entries already exists. Resolving here would leave the
      // isolate believing a schema with no edges table is complete.
      const execd: string[] = [];
      let failEdges = true;
      const DB = {
        async exec(sql: string) {
          if (failEdges && sql.includes("CREATE TABLE IF NOT EXISTS edges")) throw new Error("D1_ERROR: Network connection lost.");
          execd.push(sql);
        },
        prepare: () => { throw new Error("unexpected prepare"); },
      } as unknown as D1Database;
      const env = makeTestEnv(undefined, { DB });

      await expect(initializeDatabase(env)).rejects.toThrow();
      expect(execd.some(s => s.includes("CREATE TABLE IF NOT EXISTS edges"))).toBe(false);

      failEdges = false;
      await initializeDatabase(env);
      expect(execd.some(s => s.includes("CREATE TABLE IF NOT EXISTS edges"))).toBe(true);
    });

    it("still swallows the routine duplicate-column ALTER error", async () => {
      // The one expected failure: every run after the first. It must NOT reject.
      const { env } = makeMigrationDb(ALL_COLUMNS, []);
      await expect(initializeDatabase(env)).resolves.toBeUndefined();
    });

    it("rejects on an ALTER failure that is not duplicate-column", async () => {
      const DB = {
        async exec(sql: string) {
          if (sql.startsWith("ALTER TABLE entries ADD COLUMN importance_score")) {
            throw new Error("D1_ERROR: database is locked");
          }
        },
        prepare: () => { throw new Error("unexpected prepare"); },
      } as unknown as D1Database;

      await expect(initializeDatabase(makeTestEnv(undefined, { DB }))).rejects.toThrow(/database is locked/);
    });
  });

  it("applies every missing ALTER on a partially-migrated brain", async () => {
    const { env, execd, prepared } = makeMigrationDb(["recall_count", "importance_score"], rowsAged(1));

    await initializeDatabase(env);

    for (const [, alter] of MIGRATION) expect(execd).toContain(alter);
    expect(prepared).toEqual([]);
  });

  // The backfill this replaced wrote one row per entry. On a 50,000-entry brain that was
  // half of D1's daily row-write budget in a single statement, and exceeding the cap
  // fails every query account-wide until 00:00 UTC.
  it("never backfills, at any brain size", async () => {
    const { env, execd, prepared, rows } = makeMigrationDb([], rowsAged(50_000));

    await initializeDatabase(env);

    const all = [...execd, ...prepared];
    expect(all.filter(s => /UPDATE\s+entries/i.test(s))).toEqual([]);
    expect(all.filter(s => /updated_at IS NULL/i.test(s))).toEqual([]);
    expect(rows.filter(r => r.updated_at == null)).toHaveLength(50_000);
  });
});
