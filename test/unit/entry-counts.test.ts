/**
 * T-0065: entry_counts, the exact per-workspace entry counter that replaces
 * distillation's scoped COUNT(*)/cache. Real SQLite (test/helpers/sqlite-d1.ts):
 * the triggers' correctness under concurrency and the migration seed's
 * atomicity are exactly what the string-matching D1 mock cannot evaluate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import type { Env } from "../../src/env";

let d1: SqliteD1;
const envFor = (sqlite: SqliteD1): Env =>
  makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });

async function countsOf(sqlite: SqliteD1): Promise<Record<string, number>> {
  const { results } = await sqlite.db.prepare(`SELECT workspace_id, n FROM entry_counts ORDER BY workspace_id`).all() as {
    results: { workspace_id: string; n: number }[];
  };
  return Object.fromEntries(results.map(r => [r.workspace_id, r.n]));
}

async function trueCountsOf(sqlite: SqliteD1): Promise<Record<string, number>> {
  const { results } = await sqlite.db.prepare(
    `SELECT workspace_id, count(*) AS n FROM entries GROUP BY workspace_id ORDER BY workspace_id`,
  ).all() as { results: { workspace_id: string; n: number }[] };
  return Object.fromEntries(results.map(r => [r.workspace_id, r.n]));
}

function insertEntry(sqlite: SqliteD1, id: string, workspaceId: string, createdAt = 1): void {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES (?, 'memory', '[]', 'api', ?, '[]', ?)`,
  ).bind(id, createdAt, workspaceId).run();
}

describe("entry_counts triggers, against real SQLite", () => {
  beforeEach(() => {
    d1 = makeSqliteD1();
  });
  afterEach(() => d1?.close());

  it("is exact after inserts across several workspaces", async () => {
    insertEntry(d1, "a1", "ws-a");
    insertEntry(d1, "a2", "ws-a");
    insertEntry(d1, "b1", "ws-b");

    expect(await countsOf(d1)).toEqual({ "ws-a": 2, "ws-b": 1 });
    expect(await countsOf(d1)).toEqual(await trueCountsOf(d1));
  });

  it("is exact after deletes", async () => {
    insertEntry(d1, "a1", "ws-a");
    insertEntry(d1, "a2", "ws-a");

    await d1.db.prepare(`DELETE FROM entries WHERE id = 'a1'`).run();

    expect(await countsOf(d1)).toEqual({ "ws-a": 1 });
  });

  it("is exact after a workspace move (share to a team)", async () => {
    insertEntry(d1, "a1", "ws-personal");

    await d1.db.prepare(`UPDATE entries SET workspace_id = 'ws-team' WHERE id = 'a1'`).run();

    expect(await countsOf(d1)).toEqual({ "ws-personal": 0, "ws-team": 1 });
  });

  it("is exact after a workspace move back (unshare)", async () => {
    insertEntry(d1, "a1", "ws-personal");
    await d1.db.prepare(`UPDATE entries SET workspace_id = 'ws-team' WHERE id = 'a1'`).run();

    await d1.db.prepare(`UPDATE entries SET workspace_id = 'ws-personal' WHERE id = 'a1'`).run();

    expect(await countsOf(d1)).toEqual({ "ws-personal": 1, "ws-team": 0 });
  });

  it("is exact across several team moves of the same entry", async () => {
    insertEntry(d1, "a1", "ws-a");
    for (const target of ["ws-b", "ws-c", "ws-a", "ws-b"]) {
      await d1.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'a1'`).bind(target).run();
    }

    expect(await countsOf(d1)).toEqual({ "ws-a": 0, "ws-b": 1, "ws-c": 0 });
  });

  it("a workspace_id UPDATE that re-sets the SAME value never touches entry_counts (the update trigger's WHEN guard)", async () => {
    insertEntry(d1, "a1", "ws-a");
    // total_changes() (unlike node:sqlite's per-statement .changes, see the
    // rows_written test below) includes trigger-caused writes, so it can
    // distinguish "the WHEN guard suppressed the body" from "it ran and
    // happened to net to the same total".
    const before = (await d1.db.prepare(`SELECT total_changes() AS c`).first() as { c: number }).c;

    await d1.db.prepare(`UPDATE entries SET workspace_id = workspace_id WHERE id = 'a1'`).run();

    const after = (await d1.db.prepare(`SELECT total_changes() AS c`).first() as { c: number }).c;
    expect(after - before).toBe(1); // only the entries row; entry_counts untouched
    expect(await countsOf(d1)).toEqual({ "ws-a": 1 });
  });

  it("a recall_count-only UPDATE does not fire the workspace_id trigger", async () => {
    insertEntry(d1, "a1", "ws-a");
    const before = await countsOf(d1);

    await d1.db.prepare(`UPDATE entries SET recall_count = recall_count + 1 WHERE id = 'a1'`).run();

    expect(await countsOf(d1)).toEqual(before);
  });

  it("is exact after a bulk import", async () => {
    const statements = [];
    for (let i = 0; i < 200; i++) {
      statements.push(
        d1.db.prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES (?, 'memory', '[]', 'api', 1, '[]', ?)`,
        ).bind(`bulk-${i}`, i % 2 === 0 ? "ws-a" : "ws-b"),
      );
    }
    await d1.db.batch(statements);

    expect(await countsOf(d1)).toEqual({ "ws-a": 100, "ws-b": 100 });
  });

  it("team deletion (bulk delete of every entry in a workspace) keeps SUM correct — the row stays at n = 0, not deleted", async () => {
    insertEntry(d1, "a1", "ws-team");
    insertEntry(d1, "a2", "ws-team");
    insertEntry(d1, "b1", "ws-b");

    await d1.db.prepare(`DELETE FROM entries WHERE workspace_id = 'ws-team'`).run();

    const row = await d1.db.prepare(`SELECT n FROM entry_counts WHERE workspace_id = 'ws-team'`).first() as { n: number } | null;
    expect(row).toEqual({ n: 0 }); // kept, not deleted (documented design decision)
    expect(await countsOf(d1)).toEqual({ "ws-b": 1, "ws-team": 0 });
    const total = await d1.db.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM entry_counts`).first() as { n: number };
    expect(total.n).toBe(1); // SUM is correct either way
  });

  it("rows_written per capture: measured, not assumed", async () => {
    // node:sqlite's StatementSync.run().changes reports only the directly
    // executed statement's own row count — it does NOT include rows an
    // AFTER trigger writes to a different table (verified here: the entry
    // genuinely lands in entry_counts, per the other tests in this file, yet
    // this delta stays flat). Measured value: 1 (no visible increase over a
    // brain without entry_counts). Real D1's own rows_written accounting may
    // differ from this test double; this is what this repo's own harness can
    // measure, reported as asked rather than assumed.
    const result = await d1.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES ('x1', 'memory', '[]', 'api', 1, '[]', 'ws-a')`,
    ).run() as { meta: { rows_written: number } };
    expect(result.meta.rows_written).toBe(1);
    expect((await d1.db.prepare(`SELECT n FROM entry_counts WHERE workspace_id = 'ws-a'`).first() as { n: number }).n).toBe(1); // the row is really there
  });
});

describe("entry_counts seed, against real SQLite", () => {
  beforeEach(() => { resetDatabaseInit(); });
  afterEach(() => d1?.close());

  it("seeds exact per-workspace counts on a populated pre-T-0065 brain (the migration)", async () => {
    d1 = makeSqliteD1(); // schema.sql applied, then rewound to its pre-T-0065 shape below
    await d1.db.exec(
      `DROP TRIGGER IF EXISTS entry_counts_insert; DROP TRIGGER IF EXISTS entry_counts_update;` +
      `DROP TRIGGER IF EXISTS entry_counts_delete; DROP TABLE IF EXISTS entry_counts;`,
    );
    // Rows written directly, with no entry_counts triggers to track them —
    // exactly what a brain that predates T-0065 looks like.
    insertEntry(d1, "a1", "ws-a");
    insertEntry(d1, "a2", "ws-a");
    insertEntry(d1, "b1", "ws-b");
    insertEntry(d1, "legacy", "");

    await initializeDatabase(envFor(d1));

    expect(await countsOf(d1)).toEqual({ "": 1, "ws-a": 2, "ws-b": 1 });
  });

  it("a concurrent entries insert landing exactly between the creation batch and the seed is neither double-counted nor missed", async () => {
    d1 = makeSqliteD1();
    await d1.db.exec(
      `DROP TRIGGER IF EXISTS entry_counts_insert; DROP TRIGGER IF EXISTS entry_counts_update;` +
      `DROP TRIGGER IF EXISTS entry_counts_delete; DROP TABLE IF EXISTS entry_counts;`,
    );
    for (let i = 0; i < 20; i++) insertEntry(d1, `pre-${i}`, "ws-a", i);

    const env = envFor(d1);
    // Targets the one window that matters: the sqlite-d1 helper serializes
    // every statement and batch on this connection through one FIFO queue
    // (see its enqueue() doc comment), so a concurrent write can only ever
    // land fully before or fully after any single batch — never mid-batch.
    // The only place a second isolate could genuinely race applySchema is
    // between the creation batch resolving and whatever runs next, so this
    // wraps batch() to fire the concurrent insert at exactly that instant,
    // deterministically, rather than hoping an unrelated Promise.all
    // schedules into it.
    const realBatch = env.DB.batch.bind(env.DB);
    let injected = false;
    env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      const result = await realBatch(statements);
      if (!injected && statements.some(s => (s as unknown as { sourceSql?: () => string }).sourceSql?.().includes("entry_counts"))) {
        injected = true;
        insertEntry(d1, "concurrent", "ws-a", 999);
      }
      return result;
    }) as typeof env.DB.batch;

    await initializeDatabase(env);

    expect(injected).toBe(true); // the injection point was actually reached
    expect(await countsOf(d1)).toEqual(await trueCountsOf(d1));
    expect((await d1.db.prepare(`SELECT n FROM entry_counts WHERE workspace_id = 'ws-a'`).first() as { n: number }).n).toBe(21);
  });
});
