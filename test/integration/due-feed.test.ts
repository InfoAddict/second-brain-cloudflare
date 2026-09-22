/**
 * GET /due — the time-anchored feed a future push sender reads from.
 * Real SQLite, like GET /stale and GET /loops: this endpoint IS a WHERE
 * clause, and a mock that matches queries by substring cannot tell a correct
 * predicate from a broken one.
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

function dbOf(s: SqliteD1) {
  return { prepare: (sql: string) => s.db.prepare(sql), exec: (sql: string) => s.db.exec(sql), batch: (stmts: any[]) => s.db.batch(stmts) };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  setDbReady(true);
  return s;
}

const envOf = (s: SqliteD1): Env => makeTestEnv(dbOf(s) as any);

const DAY = 24 * 60 * 60 * 1000;

function seedWhen(s: SqliteD1, id: string, content: string, whenAt: number, whenKind = "due", whenSource = "explicit") {
  s.seed({ id, content, createdAt: 1000 });
  s.db.prepare(`UPDATE entries SET when_at = ?, when_kind = ?, when_source = ? WHERE id = ?`)
    .bind(whenAt, whenKind, whenSource, id).run();
}

describe("GET /due", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("GET", "/due", { token: null }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("buckets into overdue and upcoming, and excludes entries with no when", async () => {
    sq = await migrated();
    const now = Date.now();
    seedWhen(sq, "past", "Renew the passport", now - DAY);
    seedWhen(sq, "soon", "File the report", now + DAY);
    seedWhen(sq, "far", "Something next month", now + 30 * DAY);
    sq.seed({ id: "no-when", content: "Never anchored", createdAt: 1000 });

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;

    expect(data.overdue.map((r: any) => r.id)).toEqual(["past"]);
    expect(data.upcoming.map((r: any) => r.id)).toEqual(["soon"]);
    expect(data.counts).toEqual({ overdue: 1, upcoming: 1 });
  });

  it("orders each bucket by when_at ascending", async () => {
    sq = await migrated();
    const now = Date.now();
    seedWhen(sq, "later-overdue", "B", now - DAY);
    seedWhen(sq, "earlier-overdue", "A", now - 2 * DAY);
    seedWhen(sq, "later-upcoming", "D", now + 2 * DAY);
    seedWhen(sq, "earlier-upcoming", "C", now + DAY);

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;

    expect(data.overdue.map((r: any) => r.id)).toEqual(["earlier-overdue", "later-overdue"]);
    expect(data.upcoming.map((r: any) => r.id)).toEqual(["earlier-upcoming", "later-upcoming"]);
  });

  it("carries content (truncated), what: null, tags, and the when fields", async () => {
    sq = await migrated();
    const now = Date.now();
    const longContent = "x".repeat(300);
    sq.seed({ id: "e1", content: longContent, createdAt: 1000, tags: ["task", "work"] });
    sq.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'regex' WHERE id = 'e1'`)
      .bind(now - DAY).run();

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;

    const row = data.overdue[0];
    expect(row.content).toBe(longContent.slice(0, 200));
    expect(row.content.length).toBe(200);
    expect(row.what).toBeNull();
    expect(row.tags).toEqual(expect.arrayContaining(["task", "work"]));
    expect(row.when_kind).toBe("due");
    expect(row.when_source).toBe("regex");
    expect(typeof row.when_at).toBe("number");
  });

  it("treats the exact 48-hour boundary as upcoming, not excluded", async () => {
    sq = await migrated();
    const now = Date.now();
    seedWhen(sq, "boundary", "Right at the edge", now + 48 * 60 * 60 * 1000);

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;
    expect(data.upcoming.map((r: any) => r.id)).toContain("boundary");
  });

  it("does not include something more than 48 hours out", async () => {
    sq = await migrated();
    const now = Date.now();
    seedWhen(sq, "too-far", "Not yet", now + 49 * 60 * 60 * 1000);

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;
    expect(data.upcoming).toEqual([]);
    expect(data.overdue).toEqual([]);
  });

  it("caps each bucket at 20 rows but counts the whole bucket", async () => {
    sq = await migrated();
    const now = Date.now();
    for (let i = 0; i < 25; i++) seedWhen(sq, `overdue-${i}`, `Item ${i}`, now - (i + 1) * 1000);

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;
    expect(data.overdue).toHaveLength(20);
    expect(data.counts.overdue).toBe(25);
  });
});
