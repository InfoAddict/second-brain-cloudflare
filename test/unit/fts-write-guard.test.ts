import { describe, it, expect, vi, beforeEach } from "vitest";
import { withFtsWriteGuard } from "../../src/db/fts-write-guard";
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
  beforeEach(() => { vi.mocked(repairFtsIndex).mockClear(); });

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
});
