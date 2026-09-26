import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FTS_LIVENESS_SQL, ftsCountSafeToken, ftsMatchQuery, ftsReady, ftsShortToken, isFtsLive, isFtsLiveRows, planFtsMatch, resetFtsReadyMemo } from "../../src/recall/fts";
import { FTS_MATCH_BUDGET, KEYWORD_CANDIDATE_LIMIT, FTS_READY_CACHE_MS, FTS_READY_KV_KEY } from "../../src/constants";
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

describe("ftsShortToken", () => {
  it("is true only for a token the trigram floor excludes, counted in codepoints", () => {
    for (const t of ["io", "k8", "東京", "a"]) expect(ftsShortToken(t), t).toBe(true);
    for (const t of ["abc", "東京タ", "k8s"]) expect(ftsShortToken(t), t).toBe(false);
  });
  it("leaves a NUL token out: it stays on the LIKE path with the rest of the query", () => {
    expect(ftsShortToken("a\u0000")).toBe(false);
  });
});

describe("planFtsMatch", () => {
  const LIMIT = KEYWORD_CANDIDATE_LIMIT;
  const df = (o: Record<string, number>) => new Map(Object.entries(o));
  it("is one OR over every token when df is unknown, partial, or within the budget", () => {
    const all = { matches: ['"alpha" OR "beta"'], bounded: false, andTier: false };
    expect(planFtsMatch(["alpha", "beta"], null, LIMIT)).toEqual(all);
    expect(planFtsMatch(["alpha", "beta"], df({ alpha: 5 }), LIMIT)).toEqual(all);
    expect(planFtsMatch(["alpha", "beta"], df({ alpha: FTS_MATCH_BUDGET - 1, beta: 1 }), LIMIT)).toEqual(all);
  });
  it("bounds an over-budget query: the AND of every token, then the rarest tokens that fit", () => {
    const plan = planFtsMatch(["common", "mid", "rare"], df({ common: 3000, mid: 1500, rare: 400 }), LIMIT);
    expect(plan).toEqual({ matches: ['"common" "mid" "rare"', '"rare" OR "mid"'], bounded: true, andTier: true });
  });
  it("stops at the first token that would cross the OR tier's budget rather than skipping to a smaller one", () => {
    const plan = planFtsMatch(["a1b", "c2d", "e3f"], df({ a1b: 900, c2d: 1200, e3f: 1300 }), LIMIT);
    expect(plan?.matches[1]).toBe('"a1b"');
  });
  it("fits tokens up to FTS_MATCH_BUDGET inclusive, and no further", () => {
    const at = planFtsMatch(["aaa", "bbb"], df({ aaa: FTS_MATCH_BUDGET, bbb: 5000 }), LIMIT);
    expect(at?.matches[1]).toBe('"aaa"');
    const over = planFtsMatch(["aaa", "bbb"], df({ aaa: FTS_MATCH_BUDGET + 1, bbb: 5000 }), LIMIT);
    expect(over?.matches).toEqual(['"aaa" "bbb"']);
  });
  it("keeps only the AND when no token fits alone, and has no plan for a lone over-budget token", () => {
    expect(planFtsMatch(["widget", "gadget"], df({ widget: 2100, gadget: 2100 }), LIMIT)).toEqual({ matches: ['"widget" "gadget"'], bounded: true, andTier: true });
    expect(planFtsMatch(["widget"], df({ widget: 2100 }), LIMIT)).toBeNull();
  });
  it("keeps a mid-df token in the OR tier: an answer carrying only it stays reachable", () => {
    // 1200 is past a candidate-limit-sized budget but within FTS_MATCH_BUDGET
    expect(planFtsMatch(["common", "mid"], df({ common: 5000, mid: 1200 }), LIMIT)?.matches).toEqual(['"common" "mid"', '"mid"']);
  });
  it("leaves the AND tier out when the OR tier returns all of its matches: the AND adds no candidate", () => {
    const d = df({ common: 5000, rare: 100 });
    expect(planFtsMatch(["common", "rare"], d, 500)).toEqual({ matches: ['"rare"'], bounded: true, andTier: false });
    expect(planFtsMatch(["common", "rare"], d, 100)?.andTier).toBe(false);
    expect(planFtsMatch(["common", "rare"], d, 99)).toEqual({ matches: ['"common" "rare"', '"rare"'], bounded: true, andTier: true });
  });
  it("keeps the AND tier when there is no OR tier to hold its rows", () => {
    expect(planFtsMatch(["widget", "gadget"], df({ widget: 2100, gadget: 2100 }), 100_000)?.andTier).toBe(true);
  });
  it("has no AND tier for a single token, whose bounded plan is just the fitting OR", () => {
    expect(planFtsMatch(["only"], df({ only: 10 }), LIMIT)).toEqual({ matches: ['"only"'], bounded: false, andTier: false });
  });
  it("drops what a token known to be absent makes pointless: the AND, and the token itself from the OR", () => {
    expect(planFtsMatch(["widget", "zzzrare"], df({ widget: 2100, zzzrare: 0 }), LIMIT)).toBeNull();
    expect(planFtsMatch(["widget", "gadget", "zzzrare"], df({ widget: 2100, gadget: 5, zzzrare: 0 }), LIMIT))
      .toEqual({ matches: ['"gadget"'], bounded: true, andTier: false });
  });
  it("doubles internal quotes so user text cannot inject FTS syntax", () => {
    expect(planFtsMatch(['a"b', "cde"], df({ 'a"b': 3000, cde: 10 }), 5)?.matches).toEqual(['"a""b" "cde"', '"cde"']);
  });
});

describe("ftsCountSafeToken", () => {
  it("accepts plain ASCII terms", () => {
    expect(ftsCountSafeToken("dashboard")).toBe(true);
    expect(ftsCountSafeToken("v1.9")).toBe(true);
    expect(ftsCountSafeToken("#149")).toBe(true);
  });
  it("accepts CJK, which has no case to fold", () => {
    expect(ftsCountSafeToken("認証")).toBe(true);
    expect(ftsCountSafeToken("東京都庁")).toBe(true);
  });
  it("rejects a term with a cased non-ASCII character (LIKE folds ASCII case only; trigram folds wider)", () => {
    expect(ftsCountSafeToken("café")).toBe(false);
    expect(ftsCountSafeToken("résumé")).toBe(false);
    expect(ftsCountSafeToken("naïve")).toBe(false);
  });
  it("accepts non-ASCII punctuation and symbols with no case distinction", () => {
    expect(ftsCountSafeToken("—dash—")).toBe(true);
    expect(ftsCountSafeToken("100€")).toBe(true);
  });
  it("proves the divergence this guard exists for, against real FTS5 trigram", () => {
    // SQLite's LIKE folds ASCII case only; the trigram tokenizer's casefold
    // (case_sensitive defaults to 0) reaches accented Latin too. A row
    // spelled with the uppercase accented form matches a MATCH query for the
    // lowercase term, but not the equivalent LIKE pattern — exactly the gap
    // ftsCountSafeToken exists to route around.
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE VIRTUAL TABLE probe USING fts5(content, tokenize='trigram')`);
    db.prepare(`INSERT INTO probe(content) VALUES(?)`).run("the RÉSUMÉ was updated");
    const ftsHit = db.prepare(`SELECT rowid FROM probe WHERE probe MATCH ?`).all(ftsMatchQuery(["résumé"])!);
    const likeHit = db.prepare(`SELECT rowid FROM probe WHERE content LIKE ?`).all("%résumé%");
    expect(ftsHit).toHaveLength(1);
    expect(likeHit).toHaveLength(0); // LIKE never sees it: this is the divergence, not a bug in either operator
    expect(ftsCountSafeToken("résumé")).toBe(false); // and this is why T-0059 routes it to the LIKE count instead
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

describe("isFtsLiveRows / isFtsLive — write-path isolation v2.2 invariant", () => {
  // S1 (v2.2 re-review): names alone are not enough — an ordinary table or a
  // right-named, wrong-body trigger must read as NOT live. Definition
  // matching is also the upgrade path for a future release that changes a
  // trigger body: the old body reads as not-live and gets rebuilt nightly.
  it("is live only when all four rows are present with their exact DDL text", () => {
    const table = { name: "entries_fts", sql: `CREATE VIRTUAL TABLE entries_fts USING fts5(id UNINDEXED, content, tokenize='trigram')` };
    const insert = { name: "entries_fts_insert", sql: `CREATE TRIGGER entries_fts_insert\n    AFTER INSERT ON entries\n    BEGIN\n      INSERT INTO entries_fts (rowid, id, content) VALUES (NEW.rowid, NEW.id, NEW.content);\n    END` };
    const update = { name: "entries_fts_update", sql: `CREATE TRIGGER entries_fts_update\n    AFTER UPDATE ON entries\n    WHEN OLD.rowid IS NOT NEW.rowid OR OLD.id IS NOT NEW.id OR OLD.content IS NOT NEW.content\n    BEGIN\n      DELETE FROM entries_fts WHERE rowid = OLD.rowid;\n      INSERT INTO entries_fts (rowid, id, content) VALUES (NEW.rowid, NEW.id, NEW.content);\n    END` };
    const del = { name: "entries_fts_delete", sql: `CREATE TRIGGER entries_fts_delete\n    AFTER DELETE ON entries\n    BEGIN\n      DELETE FROM entries_fts WHERE rowid = OLD.rowid;\n    END` };
    expect(isFtsLiveRows([table, insert, update, del])).toBe(true);
    expect(isFtsLiveRows([table, insert, update])).toBe(false); // one missing
    expect(isFtsLiveRows([table, { ...insert, sql: "CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN SELECT 1; END" }, update, del])).toBe(false); // right name, wrong body
    expect(isFtsLiveRows([{ ...table, sql: "CREATE TABLE entries_fts (id TEXT, content TEXT)" }, insert, update, del])).toBe(false); // ordinary table, not fts5
    expect(isFtsLiveRows(null)).toBe(false);
    expect(isFtsLiveRows(undefined)).toBe(false);
    expect(isFtsLiveRows([])).toBe(false);
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

  // S1: a trigger that exists under the right name but with a body that
  // does not match what we would have created must read as not live, even
  // though the old (names-only) liveness check would have missed it.
  it("reports not live when a trigger's body does not match what we create (right name, wrong body)", async () => {
    d1 = makeSqliteD1();
    await d1.db.exec("DROP TRIGGER entries_fts_insert");
    await d1.db.exec(
      `CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
         INSERT INTO entries_fts (rowid,id,content) VALUES (NEW.rowid,NEW.id,'poisoned');
       END`,
    );
    const env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database });

    expect(await isFtsLive(env)).toBe(false);
  });

  it("reports not live for an ordinary table named entries_fts, even with correctly-named triggers", async () => {
    d1 = makeSqliteD1();
    await d1.db.exec(
      "DROP TRIGGER entries_fts_insert; DROP TRIGGER entries_fts_update; DROP TRIGGER entries_fts_delete; DROP TABLE entries_fts;",
    );
    await d1.db.exec(`CREATE TABLE entries_fts (id TEXT, content TEXT)`);
    await d1.db.exec(`CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN INSERT INTO entries_fts VALUES (NEW.id,NEW.content); END`);
    await d1.db.exec(`CREATE TRIGGER entries_fts_update AFTER UPDATE ON entries BEGIN SELECT 1; END`);
    await d1.db.exec(`CREATE TRIGGER entries_fts_delete AFTER DELETE ON entries BEGIN SELECT 1; END`);
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
