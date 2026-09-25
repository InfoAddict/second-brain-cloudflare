/**
 * The keyword arm reads full note text for every candidate row, and the Worker pays to parse and scan every byte of it.
 * A second window or tier only ever fills the slots the first leaves under the limit, so it must not ask for more.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { keywordSearch, recallEntries } from "../../src/recall/search";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const LIMIT = 50;
let sqlite: SqliteD1;
let env: Env;
/** Every prepared statement with its bound values, and how many rows it returned. */
let seen: { sql: string; binds: unknown[]; rows: number }[] = [];

function spy(db: SqliteD1["db"]): Env["DB"] {
  const info = new WeakMap<object, { sql: string; binds: unknown[] }>();
  let inBatch = false;
  const wrap = (stmt: any, sql: string, binds: unknown[]): any => {
    const proxy: any = new Proxy(stmt, {
      get: (st, k) => {
        if (k === "bind") return (...b: unknown[]) => wrap(st.bind(...b), sql, b);
        if (k === "all" || k === "first" || k === "run") return async (...a: unknown[]) => { const r = await st[k](...a); if (!inBatch) seen.push({ sql, binds, rows: r?.results?.length ?? 0 }); return r; };
        const v = st[k]; return typeof v === "function" ? v.bind(st) : v;
      },
    });
    info.set(proxy, { sql, binds });
    return proxy;
  };
  return new Proxy(db as object as Record<string, any>, {
    get: (t, k) => {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql), sql, []);
      if (k === "batch") return async (stmts: any[]) => {
        inBatch = true;
        try { const res = await t.batch(stmts); stmts.forEach((st, i) => { const meta = info.get(st); if (meta) seen.push({ ...meta, rows: res[i]?.results?.length ?? 0 }); }); return res; } finally { inBatch = false; }
      };
      return typeof t[k as string] === "function" ? t[k as string].bind(t) : t[k as string];
    },
  }) as unknown as Env["DB"];
}

/** The row limit is the bound value before the terms the statement scores (bound once each, after it). */
const limitOf = (s: { sql: string; binds: unknown[] }) => s.binds[s.binds.length - 1 - (s.sql.match(/ AS p\d+/g) ?? []).length];
const rowsRead = (pred: (sql: string) => boolean) => seen.filter(s => pred(s.sql)).reduce((n, s) => n + s.rows, 0);
const likeWindows = () => seen.filter(s => s.sql.includes("FROM entries WHERE") && s.sql.includes("ORDER BY created_at DESC"));
const ftsTiers = () => seen.filter(s => s.sql.includes("lower(e.content) AS lc") && s.sql.includes("entries_fts MATCH"));

async function boot(ftsReady: boolean) {
  resetDatabaseInit(); resetFtsReadyMemo();
  sqlite = makeSqliteD1();
  const kv = makeMemoryKV();
  env = makeTestEnv(undefined, { DB: spy(sqlite.db), OAUTH_KV: kv, VECTORIZE: makeVectorizeMock() }) as Env;
  await initializeDatabase(env);
  if (ftsReady) await kv.put(FTS_READY_KV_KEY, "1");
  resetFtsReadyMemo();
}
afterEach(() => sqlite?.close());

describe("LIKE second window", () => {
  beforeEach(async () => {
    await boot(false);
    for (let i = 0; i < 3; i++) sqlite.seed({ id: `rare-${i}`, content: `Zorvane is a note about the harbour ${i}`, createdAt: 1_000 + i });
    for (let i = 0; i < 200; i++) sqlite.seed({ id: `common-${i}`, content: `We went over all of it again, note ${i}. Zorvane is not here`.replace("Zorvane is not here", "nothing else"), createdAt: 100_000 + i });
    seen = [];
  });

  it("asks for limit minus the rare rows, and skips the rows the first window already holds", async () => {
    const { rows } = await keywordSearch(["all", "zorvane"], env, LIMIT, {}, undefined, undefined, undefined, { df: new Map([["all", 200], ["zorvane", 3]]), total: 203 });
    const windows = likeWindows();
    expect(windows).toHaveLength(2);
    expect(limitOf(windows[0])).toBe(LIMIT);
    expect(limitOf(windows[1])).toBe(LIMIT - 3);
    expect(windows[1].sql).toMatch(/AND NOT \(content LIKE/);
    expect(rows).toHaveLength(LIMIT);
    expect(rows.filter(r => r.id.startsWith("rare-"))).toHaveLength(3);
    // the newest common rows fill the rest, exactly as before
    expect(rows.filter(r => r.id.startsWith("common-")).map(r => r.id)).toContain("common-199");
  });

  it("reads at most the limit in all, not twice it", async () => {
    await keywordSearch(["all", "zorvane"], env, LIMIT, {}, undefined, undefined, undefined, { df: new Map([["all", 200], ["zorvane", 3]]), total: 203 });
    expect(rowsRead(sql => sql.includes("FROM entries WHERE"))).toBe(LIMIT);
  });

  it("does not run the second window when the rare rows use the whole limit", async () => {
    await keywordSearch(["all", "zorvane"], env, 3, {}, undefined, undefined, undefined, { df: new Map([["all", 200], ["zorvane", 3]]), total: 203 });
    expect(likeWindows()).toHaveLength(1);
  });
});

describe("FTS second tier", () => {
  beforeEach(async () => {
    await boot(true);
    for (let i = 0; i < 800; i++) sqlite.seed({ id: `row-${i}`, content: `alpha bravo charlie ${i < 40 ? "delta " : ""}note${i}`, createdAt: i + 1 });
    for (let i = 0; i < 20; i++) sqlite.seed({ id: `lone-${i}`, content: `delta lone${i}`, createdAt: 2000 + i });
    seen = [];
  });

  const recall = (query: string, limit: number) => recallEntries({ query, topK: 5, synthesize: false }, env, { waitUntil: () => {} } as unknown as ExecutionContext, { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: limit }, {});

  it("asks the OR tier for the slots the AND tier leaves", async () => {
    await recall("alpha bravo charlie delta", LIMIT);
    const tiers = ftsTiers();
    expect(tiers).toHaveLength(2);
    expect(limitOf(tiers[0])).toBe(LIMIT);
    expect(tiers[0].rows).toBe(40);
    expect(limitOf(tiers[1])).toBe(LIMIT - 40);
  });

  it("does not read the OR tier when the AND tier already fills the limit", async () => {
    await recall("alpha bravo charlie delta", 30);
    const tiers = ftsTiers();
    expect(tiers).toHaveLength(1);
    expect(tiers[0].rows).toBe(30);
  });
});
