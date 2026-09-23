import { describe, it, expect, beforeEach } from "vitest";
import { runFtsBackfill, runFtsMaintenance } from "../../src/db/fts-backfill";
import { FTS_BACKFILL_BATCH, FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../../src/constants";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

let d1: SqliteD1;

// makeTestEnv's default KV mock never stores; the backfill's cursor and ready
// latch must be readable, so its memory KV is what every env here carries.
const envFor = (sqlite: SqliteD1): Env =>
  makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });

const seed = (sqlite: SqliteD1, n: number) => {
  for (let i = 1; i <= n; i++) {
    sqlite.db.prepare(`INSERT INTO entries (id, content, created_at) VALUES (?, ?, ?)`)
      .bind(`e${i}`, `memory number ${i} about dashboards`, i)
      .run();
  }
};

const emptyFts = (sqlite: SqliteD1) => sqlite.db.prepare(`DELETE FROM entries_fts`).run();

const ftsCount = async (sqlite: SqliteD1) =>
  await sqlite.db.prepare(`SELECT count(*) AS n FROM entries_fts`).first() as { n: number };
const shadowOf = async (sqlite: SqliteD1) =>
  (await sqlite.db.prepare(`SELECT rowid, id, content FROM entries_fts ORDER BY rowid`).all()).results;
const sourceOf = async (sqlite: SqliteD1) =>
  (await sqlite.db.prepare(`SELECT rowid, id, content FROM entries ORDER BY rowid`).all()).results;

describe("runFtsBackfill", () => {
  beforeEach(() => {
    d1 = makeSqliteD1();
  });

  it("indexes pre-FTS rows in batches behind a KV cursor and latches ready", async () => {
    // Two over a full production batch: one full page, one tail page, then
    // the resume is proven against the real FTS_BACKFILL_BATCH, unmocked.
    const total = FTS_BACKFILL_BATCH + 2;
    seed(d1, total);
    await emptyFts(d1); // rows that predate the index: no trigger fired for these
    const env = envFor(d1);

    expect(await runFtsBackfill(env)).toEqual({ indexed: FTS_BACKFILL_BATCH, done: false });
    expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe(String(FTS_BACKFILL_BATCH));
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();

    expect(await runFtsBackfill(env)).toEqual({ indexed: 2, done: true });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");

    expect(await ftsCount(d1)).toEqual({ n: total });
    // Every entry indexed exactly once: no duplicate rowids, full shadow matches.
    expect(await d1.db.prepare(
      `SELECT count(*) AS n FROM (SELECT rowid FROM entries_fts GROUP BY rowid HAVING count(*) > 1)`,
    ).first()).toEqual({ n: 0 });
    expect(await shadowOf(d1)).toEqual(await sourceOf(d1));
  });

  it("is idempotent over trigger-covered rows", async () => {
    seed(d1, 5); // triggers populated entries_fts for all five
    const env = envFor(d1);

    let result = { indexed: 0, done: false };
    while (!result.done) result = await runFtsBackfill(env);

    expect(await ftsCount(d1)).toEqual({ n: 5 });
    expect(await shadowOf(d1)).toEqual(await sourceOf(d1));
  });

  it("no-ops once the ready flag is set", async () => {
    seed(d1, 3);
    await emptyFts(d1);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    d1.issued.length = 0;

    expect(await runFtsBackfill(env)).toEqual({ indexed: 0, done: true });
    expect(d1.issued).toEqual([]);
    expect(await ftsCount(d1)).toEqual({ n: 0 });
  });

  it("indexes every entry exactly once after a repair reset the cursor", async () => {
    // Post-repair state: repairFtsIndex dropped and rebuilt an empty
    // entries_fts, reset the cursor to "0", and deleted the ready flag.
    seed(d1, 5);
    await d1.db.prepare(`DROP TABLE entries_fts`).run();
    await d1.db.prepare(
      `CREATE VIRTUAL TABLE entries_fts USING fts5(id UNINDEXED, content, tokenize='trigram')`,
    ).run();
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, "0");

    let result = { indexed: 0, done: false };
    while (!result.done) result = await runFtsBackfill(env);

    expect(await ftsCount(d1)).toEqual({ n: 5 });
    expect(await shadowOf(d1)).toEqual(await sourceOf(d1));
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
  });
});

describe("runFtsMaintenance", () => {
  beforeEach(() => {
    d1 = makeSqliteD1();
  });

  it("delegates to the backfill for now", async () => {
    seed(d1, 2);
    await emptyFts(d1);
    const env = envFor(d1);

    let result = { indexed: 0, done: false };
    while (!result.done) result = await runFtsMaintenance(env);

    expect(await ftsCount(d1)).toEqual({ n: 2 });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
  });
});
