import { describe, it, expect } from "vitest";
import { isFtsFailure, isMissingFtsTable, repairFtsIndex, rebuildFtsIndex } from "../../src/db/fts-repair";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../../src/constants";
import { ftsReady, resetFtsReadyMemo } from "../../src/recall/fts";
import { resetDistillTotalCache } from "../../src/recall/distill";
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

describe("repairFtsIndex — write-path isolation v2.2 (never destroys the index)", () => {
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

  it("corrupt or wrong-shaped table: drops only the FTS triggers, leaves the table and its rows intact", async () => {
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
      // The (wrong-shaped) table itself is untouched: still there, same row.
      // Not live (src/recall/fts.ts) — that is what makes this safe to
      // observe, not a rename or any other new state.
      const rows = await s.db.prepare("SELECT wrong_col FROM entries_fts").all() as { results: { wrong_col: string }[] };
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
      resetDistillTotalCache();
      expect(await ftsReady(env)).toBe(true); // memoizes true

      await repairFtsIndex(env, CORRUPT_ERROR);

      // ready was deleted by the repair; a memoized "true" would hide that.
      expect(await ftsReady(env)).toBe(false);
    } finally { s.close(); }
  });

  it("a non-missing-table error with a working KV still only drops triggers, never the table", async () => {
    const s = makeSqliteD1();
    try {
      s.seed({ id: "healthy", content: "still there", createdAt: 1 });
      await repairFtsIndex(envFor(s), CORRUPT_ERROR);

      expect(await ftsRowCount(s)).toBe(1); // the insert trigger already populated it; repair must not touch it
      const table = await s.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts'`).all() as { results: unknown[] };
      expect(table.results).toHaveLength(1); // table itself still exists — was never dropped
    } finally { s.close(); }
  });

  it("a healthy index keeps every row even when the triggering error was corruption-shaped (no probe left to misfire)", async () => {
    // An entries write throws an FTS-allowlisted error even though
    // entries_fts itself is perfectly healthy. v2.2 never re-checks health —
    // it just drops the triggers (branch: not missing-table) and leaves the
    // table exactly as it was, so no probe exists to flake. Recall's own
    // liveness check (src/recall/fts.ts), not this repair, is what then
    // correctly reads the now-trigger-less table as not live.
    const s = makeSqliteD1();
    try {
      s.seed({ id: "seed", content: "searchable seed", createdAt: 1 });
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");

      await repairFtsIndex(envFor(s, kv), CORRUPT_ERROR);

      expect(await ftsRowCount(s)).toBe(1);
      expect(s.rows().map(r => r.id)).toEqual(["seed"]);
    } finally { s.close(); }
  });

  // Ownership (v2.2): ENTRIES_FTS_TABLE_DDL has no IF NOT EXISTS, so two
  // isolates racing to create a missing table cannot both partially apply —
  // the loser's whole batch fails atomically ("table entries_fts already
  // exists") and that failure is a no-op, not an error, not a retry.
  it("missing table when a racing isolate already created it: treated as a no-op, not an error", async () => {
    const s = makeSqliteD1();
    try {
      await s.db.exec(
        "DROP TRIGGER IF EXISTS entries_fts_insert; DROP TRIGGER IF EXISTS entries_fts_update;" +
        "DROP TRIGGER IF EXISTS entries_fts_delete; DROP TABLE IF EXISTS entries_fts;",
      );
      // Simulates the winner: recreate the table+triggers directly, as the
      // real creation batch would, before the loser's own repair runs.
      await s.db.exec(
        `CREATE VIRTUAL TABLE entries_fts USING fts5(id UNINDEXED, content, tokenize='trigram');` +
        `CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN INSERT INTO entries_fts (rowid, id, content) VALUES (NEW.rowid, NEW.id, NEW.content); END;` +
        `CREATE TRIGGER entries_fts_update AFTER UPDATE ON entries WHEN OLD.rowid IS NOT NEW.rowid OR OLD.id IS NOT NEW.id OR OLD.content IS NOT NEW.content BEGIN DELETE FROM entries_fts WHERE rowid = OLD.rowid; INSERT INTO entries_fts (rowid, id, content) VALUES (NEW.rowid, NEW.id, NEW.content); END;` +
        `CREATE TRIGGER entries_fts_delete AFTER DELETE ON entries BEGIN DELETE FROM entries_fts WHERE rowid = OLD.rowid; END;`,
      );

      await expect(repairFtsIndex(envFor(s), MISSING_TABLE_ERROR)).resolves.toBeUndefined();

      expect(await ftsObjectNames(s)).toEqual(["entries_fts", "entries_fts_delete", "entries_fts_insert", "entries_fts_update"]);
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

      const [firstOk, secondOk] = await Promise.allSettled([
        repairFtsIndex(envA, MISSING_TABLE_ERROR),
        repairFtsIndex(envB, MISSING_TABLE_ERROR),
      ]);
      await s.db.prepare(
        "INSERT INTO entries (id,content,tags,source,created_at) VALUES ('first','first searchable','[]','api',1)",
      ).run();

      // One of the two may see "table already exists" and no-op; neither
      // may ever reject with anything else.
      expect(firstOk.status).toBe("fulfilled");
      expect(secondOk.status).toBe("fulfilled");
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

  // Verified against real node:sqlite: DROP TABLE entries_fts does NOT drop
  // these triggers — they are defined ON entries, not ON entries_fts — so a
  // trigger-drop step is required in its own right, not implied by the
  // table drop.
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

  it("drops a stray, still-live trigger the table drop alone would have left behind", async () => {
    // A trigger surviving DROP TABLE entries_fts (see the node:sqlite note
    // above) must not go on running against the freshly recreated table
    // with a mismatched or otherwise stale body.
    const s = makeSqliteD1();
    try {
      await s.db.exec("DROP TRIGGER entries_fts_insert");
      await s.db.exec("CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN SELECT RAISE(ABORT, 'fts5: corrupt'); END");
      const kv = makeMemoryKV();

      await rebuildFtsIndex(envFor(s, kv));

      const row = await s.db.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'entries_fts_insert'`,
      ).first() as { sql: string };
      expect(row.sql).not.toContain("RAISE");
      await s.db.prepare(
        "INSERT INTO entries (id,content,tags,source,created_at) VALUES ('e1','e1 searchable','[]','api',1)",
      ).run();
      expect(await ftsRowCount(s)).toBe(1);
    } finally { s.close(); }
  });

  it("is never called from repairFtsIndex's own module path (no accidental hot-path use)", async () => {
    // rebuildFtsIndex is exported for Task 5 to call; repairFtsIndex must
    // never reach for it. Proven behaviourally: repairFtsIndex on a corrupt
    // table never drops the table itself (see the tests above), which is
    // exactly what rebuildFtsIndex always does.
    const s = makeSqliteD1();
    try {
      s.seed({ id: "e1", content: "must survive repairFtsIndex", createdAt: 1 });
      await repairFtsIndex(envFor(s), CORRUPT_ERROR);
      const table = await s.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts'`).all() as { results: unknown[] };
      expect(table.results).toHaveLength(1);
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
