import { describe, it, expect, vi, beforeEach } from "vitest";
import { withFtsWriteGuard } from "../../src/db/fts-write-guard";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";

vi.mock("../../src/db/fts-repair", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/fts-repair")>();
  return { ...actual, repairFtsIndex: vi.fn().mockResolvedValue(true) };
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
    vi.mocked(repairFtsIndex).mockResolvedValue(true);
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
    // A message the OLD (unnarrowed) matcher also recognized, so this test
    // discriminates on B1(a) — "reads are never guarded" — not on B1(b)'s
    // separate tightening of which messages count as a failure.
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

  it("rethrows the original error without retrying when the index is already healthy", async () => {
    vi.mocked(repairFtsIndex).mockResolvedValueOnce(false);
    const { db, runCalls } = makeFakeDB(Number.POSITIVE_INFINITY);
    const env = withFtsWriteGuard(makeEnv(db));

    await expect(env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run())
      .rejects.toThrow(FTS_ERROR);
    expect(runCalls()).toBe(1); // repair reported nothing to fix, so no retry
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
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
});
