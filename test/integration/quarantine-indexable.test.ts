/**
 * W4 (16-t3-t4-trust-spec.md 5.3 point 1): INDEXABLE_SQL excludes held rows, so every
 * re-indexing path behind it (POST /vectorize-pending, the embedding migration counter via
 * GET /stats, and the brief's "unindexed" count) never treats a quarantined row as work to do.
 * Real SQLite, like deprecated-stays-unindexed.test.ts's identical reasoning for "deprecated":
 * a mock that recognises the query by substring would pass whether or not the WHERE clause
 * actually excludes held rows.
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import { withHold } from "../../src/quarantine/tags";
import type { Env } from "../../src/env";

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

function dbOf(s: SqliteD1) {
  return {
    prepare: (sql: string) => s.db.prepare(sql),
    exec: (sql: string) => s.db.exec(sql),
    async batch(stmts: { run(): Promise<any> }[]) {
      const out: any[] = [];
      for (const st of stmts) out.push(await st.run());
      return out.map((r: any) => ({ ...r, meta: { changes: 1, ...r?.meta } }));
    },
  };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  setDbReady(true);
  return s;
}

const envOf = (s: SqliteD1): Env => makeTestEnv(dbOf(s) as any);

/** Older than the embedding grace window, so the repair paths consider it. */
const PAST_GRACE = Date.now() - 600_000;

const vectorsOf = (s: SqliteD1, id: string) =>
  JSON.parse((s.rows().find(r => r.id === id)!.vector_ids as string) ?? "[]") as string[];

describe("a held row", () => {
  it("is not counted as not-searchable by the brief", async () => {
    sq = await migrated();
    sq.seed({ id: "genuinely-broken", content: "Failed to embed", createdAt: PAST_GRACE, vectorIds: [] });
    sq.seed({ id: "held-1", content: "Wire the deposit now", createdAt: PAST_GRACE, tags: withHold(["work"], "instruction"), vectorIds: [] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.attention.unindexed).toBe(1);
  });

  it("is not offered for repair in the settings count (GET /stats, the embedding-migration counter)", async () => {
    sq = await migrated();
    sq.seed({ id: "genuinely-broken", content: "Failed to embed", createdAt: PAST_GRACE, vectorIds: [] });
    sq.seed({ id: "held-1", content: "Wire the deposit now", createdAt: PAST_GRACE, tags: withHold(["work"], "instruction"), vectorIds: [] });

    const data = await (await worker.fetch(req("GET", "/stats"), envOf(sq), ctx)).json() as any;
    expect(data.unvectorized).toBe(1);
  });

  it("is skipped by POST /vectorize-pending", async () => {
    sq = await migrated();
    sq.seed({ id: "genuinely-broken", content: "Failed to embed", createdAt: PAST_GRACE, vectorIds: [] });
    sq.seed({ id: "held-1", content: "Wire the deposit now", createdAt: PAST_GRACE, tags: withHold(["work"], "instruction"), vectorIds: [] });

    const data = await (await worker.fetch(req("POST", "/vectorize-pending"), envOf(sq), ctx)).json() as any;
    expect(data.processed).toBe(1);
    expect(vectorsOf(sq, "genuinely-broken").length).toBeGreaterThan(0);
    // Still empty: a held row must never be re-vectorized.
    expect(vectorsOf(sq, "held-1")).toEqual([]);
  });

  it("does not leave the repair loop with work it refuses to do", async () => {
    sq = await migrated();
    sq.seed({ id: "held-1", content: "Wire the deposit now", createdAt: PAST_GRACE, tags: withHold(["work"], "instruction"), vectorIds: [] });

    const data = await (await worker.fetch(req("POST", "/vectorize-pending"), envOf(sq), ctx)).json() as any;
    expect(data.processed).toBe(0);
    expect(data.remaining).toBe(0);
  });
});
