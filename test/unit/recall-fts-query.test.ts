import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FTS_LIVENESS_SQL, ftsMatchQuery, ftsReady, isFtsLive, isFtsLiveCount, resetFtsReadyMemo } from "../../src/recall/fts";
import { FTS_READY_CACHE_MS, FTS_READY_KV_KEY } from "../../src/constants";
import { tokenizeQuery } from "../../src/text/tokenize";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";

describe("ftsMatchQuery", () => {
  it("quotes each token and joins with OR", () => {
    expect(ftsMatchQuery(["dashboard", "redesign"])).toBe(`"dashboard" OR "redesign"`);
  });
  it("doubles internal quotes so user tokens cannot inject FTS syntax", () => {
    expect(ftsMatchQuery([`say "hi"`])).toBe(`"say ""hi"""`);
  });
  it("drops tokens below the trigram floor and returns null when none survive", () => {
    expect(ftsMatchQuery(["ab", "dashboard"])).toBe(`"dashboard"`);
    expect(ftsMatchQuery(["ab", "x"])).toBeNull();
    expect(ftsMatchQuery([])).toBeNull();
  });
  it("counts codepoints, not UTF-16 units", () => {
    expect(ftsMatchQuery(["日本語"])).toBe(`"日本語"`); // 3 codepoints: eligible
  });
  it("drops tokens carrying NUL, which aborts MATCH with an unterminated string", () => {
    expect(ftsMatchQuery(["ab\0xyz", "dashboard"])).toBe(`"dashboard"`);
    expect(ftsMatchQuery(["abc\0xyz"])).toBeNull();
    expect(ftsMatchQuery(["\0\0\0"])).toBeNull();
  });
  it("keeps other C0 controls eligible, since real MATCH runs and matches them", () => {
    expect(ftsMatchQuery(["abc\tdef"])).toBe(`"abc\tdef"`);
    expect(ftsMatchQuery(["abc\u007fdef"])).toBe(`"abc\u007fdef"`);
  });
  it("runs a NUL-containing query through real FTS5 MATCH without throwing", () => {
    // The tokenizer can emit one: abc\0xyz is a plain ASCII chunk whose NUL
    // never touches its edges, so it survives asciiToken's trim.
    expect(tokenizeQuery("abc\0xyz")).toContain("abc\0xyz");
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE VIRTUAL TABLE probe USING fts5(content, tokenize='trigram')`);
    db.prepare(`INSERT INTO probe(content) VALUES(?)`).run("the dashboard redesign shipped");
    const q = ftsMatchQuery(["dashboard\0xyz", "dashboard"]);
    expect(q).toBe(`"dashboard"`);
    expect(db.prepare(`SELECT rowid FROM probe WHERE probe MATCH ?`).get(q!)).toEqual({ rowid: 1 });
    db.close();
  });
});

describe("ftsReady", () => {
  // The readiness answer is cached in both directions for FTS_READY_CACHE_MS:
  // one KV read per recall window instead of one per request. A failure is
  // never cached — the next call retries.
  beforeEach(() => {
    resetFtsReadyMemo();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetFtsReadyMemo();
  });
  const envWith = (value: string | null, fail = false) => ({
    OAUTH_KV: { get: fail ? vi.fn().mockRejectedValue(new Error("kv down")) : vi.fn().mockResolvedValue(value) },
  }) as any;

  it("caches false within the TTL and re-reads after it", async () => {
    vi.setSystemTime(0);
    const env = envWith(null);
    expect(await ftsReady(env)).toBe(false);
    expect(await ftsReady(env)).toBe(false);
    expect(env.OAUTH_KV.get).toHaveBeenCalledTimes(1);
    vi.setSystemTime(FTS_READY_CACHE_MS + 1);
    expect(await ftsReady(env)).toBe(false);
    expect(env.OAUTH_KV.get).toHaveBeenCalledTimes(2);
  });
  it("caches true within the TTL and re-reads after it", async () => {
    vi.setSystemTime(0);
    const env = envWith("1");
    expect(await ftsReady(env)).toBe(true);
    expect(await ftsReady(env)).toBe(true);
    expect(env.OAUTH_KV.get).toHaveBeenCalledTimes(1);
    vi.setSystemTime(FTS_READY_CACHE_MS + 1);
    expect(await ftsReady(env)).toBe(true);
    expect(env.OAUTH_KV.get).toHaveBeenCalledTimes(2);
  });
  it("observes a cleared flag after the TTL when true was cached", async () => {
    vi.setSystemTime(0);
    const env = envWith("1");
    expect(await ftsReady(env)).toBe(true);
    (env.OAUTH_KV.get as any).mockResolvedValue(null);
    vi.setSystemTime(FTS_READY_CACHE_MS - 1);
    expect(await ftsReady(env)).toBe(true);
    vi.setSystemTime(FTS_READY_CACHE_MS + 1);
    expect(await ftsReady(env)).toBe(false);
  });
  it("never caches a KV failure", async () => {
    vi.setSystemTime(0);
    let fail = true;
    const env = {
      OAUTH_KV: { get: vi.fn(async () => {
        if (fail) throw new Error("kv down");
        return "1";
      }) },
    } as any;
    expect(await ftsReady(env)).toBe(false);
    fail = false;
    vi.setSystemTime(1); // one ms later, still inside any TTL window
    expect(await ftsReady(env)).toBe(true);
  });
});

describe("isFtsLiveCount / isFtsLive — write-path isolation v2.2 invariant", () => {
  it("is live only when the count is exactly 4 (table plus all three triggers)", () => {
    expect(isFtsLiveCount({ n: 4 })).toBe(true);
    expect(isFtsLiveCount({ n: 0 })).toBe(false);
    expect(isFtsLiveCount({ n: 1 })).toBe(false);
    expect(isFtsLiveCount({ n: 3 })).toBe(false);
    expect(isFtsLiveCount(null)).toBe(false);
    expect(isFtsLiveCount(undefined)).toBe(false);
  });

  let d1: SqliteD1;
  afterEach(() => d1?.close());

  it("reports live against a real, fully-migrated schema", async () => {
    d1 = makeSqliteD1();
    const env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database });

    expect(await isFtsLive(env)).toBe(true);
  });

  it("reports not live when a trigger is missing", async () => {
    d1 = makeSqliteD1();
    await d1.db.exec("DROP TRIGGER entries_fts_insert");
    const env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database });

    expect(await isFtsLive(env)).toBe(false);
  });

  it("reports not live when the table itself is missing", async () => {
    d1 = makeSqliteD1();
    await d1.db.exec("DROP TABLE entries_fts");
    const env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database });

    expect(await isFtsLive(env)).toBe(false);
  });

  it("costs exactly one D1 statement", async () => {
    d1 = makeSqliteD1();
    d1.issued.length = 0;
    const env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database });

    await isFtsLive(env);

    expect(d1.issued).toEqual([FTS_LIVENESS_SQL]);
  });
});
