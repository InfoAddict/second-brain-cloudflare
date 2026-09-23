import { describe, it, expect, vi } from "vitest";
import { isFtsFailure, isMissingFtsTable, repairFtsIndex, rebuildFtsIndex } from "../../src/db/fts-repair";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../../src/constants";
import { ftsReady, resetFtsReadyMemo } from "../../src/recall/fts";
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

  // v2.1: the durable disabled marker renames entries_fts to
  // entries_fts_disabled. An error naming THAT table must never be read as
  // "entries_fts is missing" — the `\b` boundary after "entries_fts" already
  // protects the missing-table pattern; verify it holds here too so a stray
  // read against the disabled table never re-triggers repair.
  it("does not match errors naming entries_fts_disabled", () => {
    expect(isFtsFailure(err("no such table: entries_fts_disabled"))).toBe(false);
    expect(isFtsFailure(err("table entries_fts_disabled has no column named id"))).toBe(false);
  });
});

describe("isMissingFtsTable", () => {
  it("is true only for the missing-table error", () => {
    expect(isMissingFtsTable(err("D1_ERROR: no such table: entries_fts: SQLITE_ERROR"))).toBe(true);
    expect(isMissingFtsTable(err("no such table: main.entries_fts"))).toBe(true);
  });

  it("is false for the other allowlisted (corruption/shape) errors", () => {
    expect(isMissingFtsTable(err("table entries_fts has no column named id"))).toBe(false);
    expect(isMissingFtsTable(err("database disk image is malformed"))).toBe(false);
    expect(isMissingFtsTable(err("vtable constructor failed: entries_fts"))).toBe(false);
    expect(isMissingFtsTable(err("SQLITE_CORRUPT_VTAB"))).toBe(false);
    expect(isMissingFtsTable(err('fts5: corruption on page 1, table "entries_fts"'))).toBe(false);
  });

  it("is false for non-matching errors", () => {
    expect(isMissingFtsTable(err("no such table: entries"))).toBe(false);
    expect(isMissingFtsTable(null)).toBe(false);
  });

  it("is false for an error naming entries_fts_disabled", () => {
    expect(isMissingFtsTable(err("no such table: entries_fts_disabled"))).toBe(false);
  });
});

function ftsRowCount(s: SqliteD1): Promise<number> {
  return s.db.prepare("SELECT count(*) AS n FROM entries_fts").first()
    .then(row => (row as { n: number }).n);
}

function ftsObjectNames(s: SqliteD1): Promise<string[]> {
  return s.db.prepare(
    `SELECT name FROM sqlite_master WHERE name IN ('entries_fts','entries_fts_insert','entries_fts_update','entries_fts_delete') ORDER BY name`,
  ).all().then(({ results }) => (results as { name: string }[]).map(r => r.name));
}

function triggerNames(s: SqliteD1): Promise<string[]> {
  return s.db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('entries_fts_insert','entries_fts_update','entries_fts_delete') ORDER BY name`,
  ).all().then(({ results }) => (results as { name: string }[]).map(r => r.name));
}

function envFor(s: SqliteD1, kv: ReturnType<typeof makeMemoryKV> = makeMemoryKV()): Env {
  return makeTestEnv(undefined, { DB: s.db as unknown as D1Database, OAUTH_KV: kv });
}

const MISSING_TABLE_ERROR = new Error("no such table: entries_fts");
const CORRUPT_ERROR = new Error("database disk image is malformed");

describe("repairFtsIndex — write-path isolation v2 (never destroys the index)", () => {
  it("missing table + KV success: creates the table and triggers, clears ready, resets cursor", async () => {
    const s = makeSqliteD1();
    try {
      await s.db.exec(
        "DROP TRIGGER IF EXISTS entries_fts_insert; DROP TRIGGER IF EXISTS entries_fts_update;" +
        "DROP TRIGGER IF EXISTS entries_fts_delete; DROP TABLE IF EXISTS entries_fts;",
      );
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");
      await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "500");
      s.issued.length = 0;

      await repairFtsIndex(envFor(s, kv), MISSING_TABLE_ERROR);

      expect(await ftsObjectNames(s)).toEqual(["entries_fts", "entries_fts_delete", "entries_fts_insert", "entries_fts_update"]);
      expect(await kv.get(FTS_READY_KV_KEY)).toBeNull();
      expect(await kv.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
      // No DROP statement is issued: a missing table is created, never dropped.
      expect(s.issued.some(sql => /^DROP/i.test(sql))).toBe(false);
    } finally { s.close(); }
  });

  it("corrupt or wrong-shaped table: drops the FTS triggers and renames it to entries_fts_disabled, rows intact under the new name", async () => {
    const s = makeSqliteD1();
    try {
      s.seed({ id: "e1", content: "existing indexed row", createdAt: 1 });
      await s.db.exec("DROP TABLE entries_fts");
      await s.db.exec("CREATE TABLE entries_fts (wrong_col TEXT)");
      await s.db.exec("INSERT INTO entries_fts (wrong_col) VALUES ('leftover')");
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");
      await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "500");

      await repairFtsIndex(envFor(s, kv), CORRUPT_ERROR);

      expect(await triggerNames(s)).toEqual([]);
      // Renamed, not dropped: the original name is gone...
      const originalName = await s.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts'`).all() as { results: unknown[] };
      expect(originalName.results).toEqual([]);
      // ...but the table and its row survive under the disabled name.
      const rows = await s.db.prepare("SELECT wrong_col FROM entries_fts_disabled").all() as { results: { wrong_col: string }[] };
      expect(rows.results).toEqual([{ wrong_col: "leftover" }]);
      expect(s.rows().map(r => r.id)).toEqual(["e1"]);
      expect(await kv.get(FTS_READY_KV_KEY)).toBeNull();
      expect(await kv.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
    } finally { s.close(); }
  });

  it("missing table + a failing KV: drops triggers only, creates no table, and does not throw", async () => {
    const s = makeSqliteD1();
    try {
      await s.db.exec("DROP TABLE entries_fts");
      const innerKv = makeMemoryKV();
      await innerKv.put(FTS_READY_KV_KEY, "1");
      await innerKv.put(FTS_BACKFILL_CURSOR_KV_KEY, "500");
      const kv = {
        get: innerKv.get.bind(innerKv),
        put: innerKv.put.bind(innerKv),
        delete: async () => { throw new Error("KV unavailable"); },
      } as unknown as KVNamespace;

      await repairFtsIndex(envFor(s, kv as never), MISSING_TABLE_ERROR);

      expect(await triggerNames(s)).toEqual([]);
      const table = await s.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts'`).all() as { results: unknown[] };
      expect(table.results).toEqual([]);
    } finally { s.close(); }
  });

  it("clears the isolate readiness cache before returning", async () => {
    const s = makeSqliteD1();
    try {
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");
      const env = envFor(s, kv);
      resetFtsReadyMemo();
      expect(await ftsReady(env)).toBe(true); // memoizes true

      await repairFtsIndex(env, CORRUPT_ERROR);

      // ready was deleted by the repair; a memoized "true" would hide that.
      expect(await ftsReady(env)).toBe(false);
    } finally { s.close(); }
  });

  it("a non-missing-table error with a working KV renames the table to entries_fts_disabled, never drops it", async () => {
    const s = makeSqliteD1();
    try {
      s.seed({ id: "healthy", content: "still there", createdAt: 1 });
      await repairFtsIndex(envFor(s), CORRUPT_ERROR);

      const disabled = await s.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts_disabled'`).all() as { results: unknown[] };
      expect(disabled.results).toHaveLength(1); // table itself still exists, renamed — was never dropped
      const row = await s.db.prepare("SELECT count(*) AS n FROM entries_fts_disabled").first() as { n: number };
      expect(row.n).toBe(1); // the insert trigger already populated it; repair must not touch its rows
    } finally { s.close(); }
  });

  it("a healthy index keeps every row even when the triggering error was corruption-shaped (no probe left to misfire)", async () => {
    // Reproduces the reviewer's scenario without the health probe that used
    // to cause it: an entries write throws an FTS-allowlisted error even
    // though entries_fts itself is perfectly healthy. v2.1 never re-checks
    // health — it renames the table out of the way (branch: not
    // missing-table) instead of dropping anything, so no probe exists to
    // flake and no row is ever destroyed, just relocated.
    const s = makeSqliteD1();
    try {
      s.seed({ id: "seed", content: "searchable seed", createdAt: 1 });
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");

      await repairFtsIndex(envFor(s, kv), CORRUPT_ERROR);

      const row = await s.db.prepare("SELECT count(*) AS n FROM entries_fts_disabled").first() as { n: number };
      expect(row.n).toBe(1);
      expect(s.rows().map(r => r.id)).toEqual(["seed"]);
    } finally { s.close(); }
  });

  it("missing table + entries_fts_disabled already exists: leaves the index down instead of recreating it", async () => {
    const s = makeSqliteD1();
    try {
      // A prior repair already renamed entries_fts away; a racing cold start
      // (or a second guarded write) re-armed the triggers in the meantime,
      // referencing a table that is genuinely missing under its own name.
      await s.db.exec("ALTER TABLE entries_fts RENAME TO entries_fts_disabled");
      const kv = makeMemoryKV();

      await repairFtsIndex(envFor(s, kv), MISSING_TABLE_ERROR);

      expect(await triggerNames(s)).toEqual([]);
      const table = await s.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts'`).all() as { results: unknown[] };
      expect(table.results).toEqual([]); // never recreated while disabled
      const disabled = await s.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts_disabled'`).all() as { results: unknown[] };
      expect(disabled.results).toHaveLength(1); // the marker itself is untouched
    } finally { s.close(); }
  });

  it("rename failure falls back to dropping only the triggers, and logs one line", async () => {
    const s = makeSqliteD1();
    try {
      s.seed({ id: "e1", content: "survives the failed rename", createdAt: 1 });
      const rawBatch = (s.db as unknown as { batch: (statements: unknown[]) => Promise<unknown> }).batch.bind(s.db);
      const db = {
        prepare: s.db.prepare.bind(s.db),
        batch: (statements: { sourceSql?: () => string }[]) => {
          if (statements.some(st => st.sourceSql?.().includes("RENAME TO entries_fts_disabled"))) {
            return Promise.reject(new Error("ALTER TABLE failed: vtable rename unsupported"));
          }
          return rawBatch(statements);
        },
      } as unknown as D1Database;
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await repairFtsIndex(makeTestEnv(undefined, { DB: db, OAUTH_KV: makeMemoryKV() }), CORRUPT_ERROR);

      expect(await triggerNames(s)).toEqual([]);
      // The rename never landed: entries_fts is still there under its own
      // name, not renamed, not dropped — only its triggers are gone.
      const original = await s.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts'`).all() as { results: unknown[] };
      expect(original.results).toHaveLength(1);
      expect(s.rows().map(r => r.id)).toEqual(["e1"]);
      expect(logSpy).toHaveBeenCalledTimes(1);
      logSpy.mockRestore();
    } finally { s.close(); }
  });

  it("cross-isolate race on a missing table: both writers persist and no row is lost", async () => {
    const s = makeSqliteD1();
    try {
      s.seed({ id: "old", content: "old searchable", createdAt: 1 });
      await s.db.exec("DROP TABLE entries_fts");

      // Two "isolates": distinct env/DB-binding objects over the same
      // underlying connection, so envRefs/patched in the write guard treat
      // them as unrelated — nothing here coalesces the two repairs.
      const dbA = { prepare: s.db.prepare.bind(s.db), batch: s.db.batch.bind(s.db) } as unknown as D1Database;
      const dbB = { prepare: s.db.prepare.bind(s.db), batch: s.db.batch.bind(s.db) } as unknown as D1Database;
      const kvA = makeMemoryKV();
      const kvB = makeMemoryKV();
      const envA = envFor(s); (envA as { DB: D1Database }).DB = dbA; (envA as { OAUTH_KV: unknown }).OAUTH_KV = kvA;
      const envB = envFor(s); (envB as { DB: D1Database }).DB = dbB; (envB as { OAUTH_KV: unknown }).OAUTH_KV = kvB;

      const [firstOk, secondOk] = await Promise.all([
        repairFtsIndex(envA, MISSING_TABLE_ERROR).then(() => true),
        repairFtsIndex(envB, MISSING_TABLE_ERROR).then(() => true),
      ]);
      await s.db.prepare(
        "INSERT INTO entries (id,content,tags,source,created_at) VALUES ('first','first searchable','[]','api',1)",
      ).run();

      expect(firstOk).toBe(true);
      expect(secondOk).toBe(true);
      const fts = (await s.db.prepare("SELECT id FROM entries_fts ORDER BY id").all() as { results: { id: string }[] }).results.map(r => r.id);
      expect(fts).toEqual(["first"]);
      expect(s.rows().map(r => r.id).sort()).toEqual(["first", "old"]);
    } finally { s.close(); }
  });
});

describe("rebuildFtsIndex — the ONLY destructive path (nightly, Task 5)", () => {
  it("drops and recreates a corrupt table, deletes ready, resets the cursor to 0", async () => {
    const s = makeSqliteD1();
    try {
      s.seed({ id: "e1", content: "will be reindexed", createdAt: 1 });
      await s.db.exec("DROP TABLE entries_fts");
      await s.db.exec("CREATE TABLE entries_fts (wrong_col TEXT)");
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");
      await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "500");

      await rebuildFtsIndex(envFor(s, kv));

      expect(await ftsObjectNames(s)).toEqual(["entries_fts", "entries_fts_delete", "entries_fts_insert", "entries_fts_update"]);
      expect(await ftsRowCount(s)).toBe(0);
      expect(await kv.get(FTS_READY_KV_KEY)).toBeNull();
      expect(await kv.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
    } finally { s.close(); }
  });

  it("drops and recreates a table that is missing its sync triggers", async () => {
    const s = makeSqliteD1();
    try {
      await s.db.exec("DROP TRIGGER entries_fts_insert; DROP TRIGGER entries_fts_update; DROP TRIGGER entries_fts_delete;");
      expect(await triggerNames(s)).toEqual([]);
      const kv = makeMemoryKV();

      await rebuildFtsIndex(envFor(s, kv));

      expect(await triggerNames(s)).toEqual(["entries_fts_delete", "entries_fts_insert", "entries_fts_update"]);
      expect(await kv.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
    } finally { s.close(); }
  });

  it("is never called from repairFtsIndex's own module path (no accidental hot-path use)", async () => {
    // rebuildFtsIndex is exported for Task 5 to call; repairFtsIndex must
    // never reach for it. Proven behaviourally: repairFtsIndex on a corrupt
    // table never drops the table itself (see the tests above) — it exists
    // under one of its two names (live or disabled) — which is exactly the
    // distinction rebuildFtsIndex does not preserve (it always drops both).
    const s = makeSqliteD1();
    try {
      s.seed({ id: "e1", content: "must survive repairFtsIndex", createdAt: 1 });
      await repairFtsIndex(envFor(s), CORRUPT_ERROR);
      const table = await s.db.prepare(
        `SELECT name FROM sqlite_master WHERE name IN ('entries_fts','entries_fts_disabled')`,
      ).all() as { results: unknown[] };
      expect(table.results).toHaveLength(1);
    } finally { s.close(); }
  });

  it("clears an entries_fts_disabled marker along with entries_fts", async () => {
    const s = makeSqliteD1();
    try {
      await s.db.exec("DROP TABLE entries_fts");
      await s.db.exec("CREATE TABLE entries_fts_disabled (wrong_col TEXT)");
      await s.db.exec("INSERT INTO entries_fts_disabled (wrong_col) VALUES ('stale')");
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");
      await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "500");

      await rebuildFtsIndex(envFor(s, kv));

      const disabled = await s.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts_disabled'`).all() as { results: unknown[] };
      expect(disabled.results).toEqual([]);
      expect(await ftsObjectNames(s)).toEqual(["entries_fts", "entries_fts_delete", "entries_fts_insert", "entries_fts_update"]);
      expect(await ftsRowCount(s)).toBe(0);
      expect(await kv.get(FTS_READY_KV_KEY)).toBeNull();
      expect(await kv.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
    } finally { s.close(); }
  });

  it("invalidates KV first and aborts without any DDL if that fails", async () => {
    const s = makeSqliteD1();
    try {
      s.seed({ id: "e1", content: "must survive an aborted rebuild", createdAt: 1 });
      const kv = {
        get: async () => null,
        put: async () => { throw new Error("KV unavailable"); },
        delete: async () => { throw new Error("KV unavailable"); },
      } as unknown as KVNamespace;

      await expect(rebuildFtsIndex(envFor(s, kv))).rejects.toThrow("KV unavailable");

      expect(await ftsObjectNames(s)).toEqual(["entries_fts", "entries_fts_delete", "entries_fts_insert", "entries_fts_update"]);
      expect(s.rows().map(r => r.id)).toEqual(["e1"]);
    } finally { s.close(); }
  });
});
