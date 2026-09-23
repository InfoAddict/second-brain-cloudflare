import { describe, it, expect, vi, beforeEach } from "vitest";
import { withFtsWriteGuard } from "../../src/db/fts-write-guard";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";

vi.mock("../../src/db/fts-repair", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/fts-repair")>();
  return { ...actual, repairFtsIndex: vi.fn().mockResolvedValue(undefined) };
});
import { repairFtsIndex } from "../../src/db/fts-repair";

const FTS_ERROR = "D1_ERROR: no such table: entries_fts: SQLITE_ERROR";
const OTHER_ERROR = "UNIQUE constraint failed: users.email";

/** A minimal D1-shaped fake whose statement/batch calls fail `failTimes` times, then succeed. */
function makeFakeDB(failTimes: number, message = FTS_ERROR) {
  let runCalls = 0;
  let batchCalls = 0;
  const statement = {
    bind: (..._args: unknown[]) => statement,
    run: async () => {
      runCalls++;
      if (runCalls <= failTimes) throw new Error(message);
      return { success: true, meta: { rows_written: 1 } };
    },
  };
  const db = {
    prepare: (_sql: string) => statement,
    batch: async (statements: unknown[]) => {
      batchCalls++;
      if (batchCalls <= failTimes) throw new Error(message);
      return statements.map(() => ({ success: true, meta: { rows_written: 1 } }));
    },
  } as unknown as D1Database;
  return { db, runCalls: () => runCalls, batchCalls: () => batchCalls };
}

function makeEnv(db: D1Database): Env {
  return { DB: db, OAUTH_KV: {} as KVNamespace } as Env;
}

describe("withFtsWriteGuard", () => {
  beforeEach(() => {
    vi.mocked(repairFtsIndex).mockReset();
    vi.mocked(repairFtsIndex).mockResolvedValue(undefined);
  });

  it("passes a successful statement through untouched: no repair, one call", async () => {
    const { db, runCalls } = makeFakeDB(0);
    const env = withFtsWriteGuard(makeEnv(db));

    const result = await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run();

    expect(result).toEqual({ success: true, meta: { rows_written: 1 } });
    expect(runCalls()).toBe(1);
    expect(repairFtsIndex).not.toHaveBeenCalled();
  });

  it("repairs once and retries when a statement fails with an entries_fts error", async () => {
    const { db, runCalls } = makeFakeDB(1);
    const env = withFtsWriteGuard(makeEnv(db));

    const result = await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run();

    expect(result).toEqual({ success: true, meta: { rows_written: 1 } });
    expect(runCalls()).toBe(2);
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
    // The triggering error is handed to repairFtsIndex, which needs it to
    // distinguish missing-table from every other case (v2 spec).
    expect(vi.mocked(repairFtsIndex).mock.calls[0][1]).toBeInstanceOf(Error);
    expect((vi.mocked(repairFtsIndex).mock.calls[0][1] as Error).message).toBe(FTS_ERROR);
  });

  it("retries exactly once and then throws, without looping, when repair cannot fix it", async () => {
    const { db, runCalls } = makeFakeDB(Number.POSITIVE_INFINITY);
    const env = withFtsWriteGuard(makeEnv(db));

    await expect(env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run())
      .rejects.toThrow(FTS_ERROR);
    expect(runCalls()).toBe(2); // original attempt + exactly one retry, never more
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
  });

  it("does not repair or retry an unrelated error", async () => {
    const { db, runCalls } = makeFakeDB(Number.POSITIVE_INFINITY, OTHER_ERROR);
    const env = withFtsWriteGuard(makeEnv(db));

    await expect(env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run())
      .rejects.toThrow(OTHER_ERROR);
    expect(runCalls()).toBe(1);
    expect(repairFtsIndex).not.toHaveBeenCalled();
  });

  it("repairs once and retries a failed batch() as a whole", async () => {
    const { db, batchCalls } = makeFakeDB(1);
    const env = withFtsWriteGuard(makeEnv(db));
    const stmt = env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1");

    const result = await env.DB.batch([stmt]);

    expect(result).toEqual([{ success: true, meta: { rows_written: 1 } }]);
    expect(batchCalls()).toBe(2);
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
  });

  it("batch() retries exactly once and then throws when repair cannot fix it", async () => {
    const { db, batchCalls } = makeFakeDB(Number.POSITIVE_INFINITY);
    const env = withFtsWriteGuard(makeEnv(db));
    const stmt = env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1");

    await expect(env.DB.batch([stmt])).rejects.toThrow(FTS_ERROR);
    expect(batchCalls()).toBe(2);
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
  });

  it("reuses the same guarded DB for the same raw binding (tenancy-style memoization stays intact)", () => {
    const { db } = makeFakeDB(0);
    const rawEnv = makeEnv(db);

    const guardedA = withFtsWriteGuard(rawEnv).DB;
    const guardedB = withFtsWriteGuard(rawEnv).DB;

    expect(guardedA).toBe(guardedB);
  });

  // B1(a): only a statement that writes to `entries` is ever guarded. A read
  // — even one naming entries_fts, even one that throws something that
  // matches isFtsFailure — passes straight through, never retried, never
  // triggering a repair.
  it("does not guard a read, even one whose error would match isFtsFailure", async () => {
    const { db, runCalls } = makeFakeDB(Number.POSITIVE_INFINITY, "no such column: entries_fts.nonexistent");
    const env = withFtsWriteGuard(makeEnv(db));

    await expect(env.DB.prepare("SELECT entries_fts.nonexistent FROM entries_fts").bind().run())
      .rejects.toThrow("no such column: entries_fts.nonexistent");
    expect(runCalls()).toBe(1); // no retry, no repair
    expect(repairFtsIndex).not.toHaveBeenCalled();
  });

  it("guards a batch only when some statement in it writes to entries", async () => {
    const { db, batchCalls } = makeFakeDB(Number.POSITIVE_INFINITY, "no such column: entries_fts.nonexistent");
    const env = withFtsWriteGuard(makeEnv(db));
    const stmt = env.DB.prepare("SELECT id FROM entries_fts").bind();

    await expect(env.DB.batch([stmt])).rejects.toThrow("no such column: entries_fts.nonexistent");
    expect(batchCalls()).toBe(1); // no retry, no repair — nothing in the batch writes to entries
    expect(repairFtsIndex).not.toHaveBeenCalled();
  });

  // The reviewer's original reproduction (B1): a malformed read naming a
  // nonexistent entries_fts column dropped a healthy, indexed row. Real
  // SQLite, unmocked repairFtsIndex — a genuine end-to-end check that a read
  // error never reaches repair at all.
  it("a healthy index survives a malformed read naming an entries_fts column (B1 end-to-end)", async () => {
    const actual = await vi.importActual<typeof import("../../src/db/fts-repair")>("../../src/db/fts-repair");
    vi.mocked(repairFtsIndex).mockImplementation(actual.repairFtsIndex);
    const s = makeSqliteD1();
    try {
      s.seed({ id: "before", content: "searchable dashboard", createdAt: 1 });
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");
      await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "100");
      const env = withFtsWriteGuard(makeTestEnv(undefined, { DB: s.db as unknown as D1Database, OAUTH_KV: kv }));
      const before = await s.db.prepare("SELECT count(*) AS n FROM entries_fts").first() as { n: number };

      await expect(env.DB.prepare("SELECT entries_fts.nonexistent FROM entries_fts").all())
        .rejects.toThrow(/no such column/);

      const after = await s.db.prepare("SELECT count(*) AS n FROM entries_fts").first() as { n: number };
      expect(before.n).toBe(1);
      expect(after.n).toBe(1);
      expect(await kv.get(FTS_READY_KV_KEY)).toBe("1");
      expect(await kv.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("100");
    } finally { s.close(); }
  });

  // v2 removes the hot-path health probe entirely, so there is no longer an
  // "index was already healthy, don't retry" branch: repairFtsIndex always
  // performs an idempotent, non-destructive action when called, and the
  // guard always retries exactly once afterward.
  it("still retries exactly once even when repair had nothing destructive to undo", async () => {
    vi.mocked(repairFtsIndex).mockResolvedValueOnce(undefined);
    const { db, runCalls } = makeFakeDB(1);
    const env = withFtsWriteGuard(makeEnv(db));

    const result = await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run();

    expect(result).toEqual({ success: true, meta: { rows_written: 1 } });
    expect(runCalls()).toBe(2);
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
  });

  it("the no-failure path issues zero D1 statements to repairFtsIndex and zero KV operations", async () => {
    const kvCalls: string[] = [];
    const kv = {
      get: async () => { kvCalls.push("get"); return null; },
      put: async () => { kvCalls.push("put"); },
      delete: async () => { kvCalls.push("delete"); },
    } as unknown as KVNamespace;
    const { db } = makeFakeDB(0);
    const env = withFtsWriteGuard({ DB: db, OAUTH_KV: kv } as Env);

    await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run();

    expect(kvCalls).toEqual([]);
    expect(repairFtsIndex).not.toHaveBeenCalled();
  });

  // v2: missing table + a totally failing KV still must not fail the write.
  // repairFtsIndex falls back to dropping the triggers (best-effort KV, no
  // table create), which is enough on its own to let the retried write
  // succeed — real SQLite end to end, unmocked repairFtsIndex.
  it("a write succeeds when the table is missing and KV fails outright (triggers dropped, no table created)", async () => {
    const actual = await vi.importActual<typeof import("../../src/db/fts-repair")>("../../src/db/fts-repair");
    vi.mocked(repairFtsIndex).mockImplementation(actual.repairFtsIndex);
    const s = makeSqliteD1();
    try {
      await s.db.exec("DROP TABLE entries_fts");
      const brokenKv = {
        get: async () => null,
        put: async () => { throw new Error("KV unavailable"); },
        delete: async () => { throw new Error("KV unavailable"); },
      } as unknown as KVNamespace;
      const env = withFtsWriteGuard(makeTestEnv(undefined, { DB: s.db as unknown as D1Database, OAUTH_KV: brokenKv }));

      const result = await env.DB.prepare(
        "INSERT INTO entries (id,content,tags,source,created_at) VALUES ('e1','hello searchable','[]','api',1)",
      ).run();

      expect(result.success).toBe(true);
      expect(s.rows().map(r => r.id)).toEqual(["e1"]);
      const table = await s.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts'`).all() as { results: unknown[] };
      expect(table.results).toEqual([]); // never created — KV failed
      const triggers = await s.db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'entries_fts_%'`,
      ).all() as { results: unknown[] };
      expect(triggers.results).toEqual([]); // dropped
    } finally { s.close(); }
  });
});

describe("ENTRIES_WRITE_SQL classifier (table-driven)", () => {
  function classifiedAsEntriesWrite(sql: string): boolean {
    const raw = { bind: () => raw, run: async () => ({ success: true, meta: { rows_written: 1 } }) } as D1PreparedStatement;
    const db = { prepare: () => raw, batch: async () => [] } as unknown as D1Database;
    const env = withFtsWriteGuard({ DB: db, OAUTH_KV: makeMemoryKV() } as Env);
    return (env.DB.prepare(sql) as unknown as { __entriesWrite?: boolean }).__entriesWrite === true;
  }

  const V = (id: string) => `('${id}','${id} searchable','[]','api',1)`;

  // The reviewer's nine missed forms (fix3b-probes, T-0052 review): each was
  // a valid SQLite write to `entries` that the old regex failed to classify
  // as a guarded write.
  const POSITIVES: [string, string][] = [
    ["leading block comment", `/* comment */ INSERT INTO entries (id,content,tags,source,created_at) VALUES ${V("a")}`],
    ["leading line comment", `-- comment\nINSERT INTO entries (id,content,tags,source,created_at) VALUES ${V("b")}`],
    ["INSERT OR IGNORE", `INSERT OR IGNORE INTO entries (id,content,tags,source,created_at) VALUES ${V("c")}`],
    ["REPLACE INTO", `REPLACE INTO entries (id,content,tags,source,created_at) VALUES ${V("d")}`],
    ["double-quoted table name", `INSERT INTO "entries" (id,content,tags,source,created_at) VALUES ${V("e")}`],
    ["bracket-quoted table name", `INSERT INTO [entries] (id,content,tags,source,created_at) VALUES ${V("f")}`],
    ["backtick-quoted table name", `INSERT INTO \`entries\` (id,content,tags,source,created_at) VALUES ${V("g")}`],
    ["schema-qualified (main.entries)", `INSERT INTO main.entries (id,content,tags,source,created_at) VALUES ${V("h")}`],
    ["CTE prefix (WITH ... INSERT INTO entries)", `WITH x(v) AS (SELECT 'i') INSERT INTO entries (id,content,tags,source,created_at) SELECT v,v,'[]','api',1 FROM x`],
    // Already-working forms, kept as a regression net.
    ["canonical INSERT", `INSERT INTO entries (id,content,tags,source,created_at) VALUES ${V("j")}`],
    ["lowercase across newlines", `\ninsert\ninto\nentries (id,content,tags,source,created_at) VALUES ${V("k")}`],
    ["UPDATE with alias", `UPDATE entries AS e SET content = 'x' WHERE e.id = 'seed'`],
    ["DELETE FROM", `DELETE FROM entries WHERE id = 'x'`],
    ["UPDATE OR REPLACE", `UPDATE OR REPLACE entries SET content = 'x' WHERE id = 'y'`],
  ];

  const NEGATIVES: [string, string][] = [
    ["entries_fts", `INSERT INTO entries_fts (rowid,id,content) VALUES (1,'x','x')`],
    ["entry_events", `INSERT INTO entry_events (id) VALUES ('x')`],
    ["entries_x", `INSERT INTO entries_x (id) VALUES ('x')`],
    ["entriesé (non-ASCII identifier continuation)", `INSERT INTO entriesé (id) VALUES ('x')`],
  ];

  it.each(POSITIVES)("classifies as an entries write: %s", (_name, sql) => {
    expect(classifiedAsEntriesWrite(sql)).toBe(true);
  });

  it.each(NEGATIVES)("does not classify as an entries write: %s", (_name, sql) => {
    expect(classifiedAsEntriesWrite(sql)).toBe(false);
  });
});
