/**
 * POST /insights/accrue — run one accrual pass on demand, and report what
 * it did.
 *
 * The nightly cron (runInsightAccrual, src/insight/candidates.ts) examines
 * only ACCRUAL_SEED_LIMIT (25) entries a run, so a self-hoster installing
 * this against an existing brain of a few thousand entries would otherwise
 * wait months for the backfill cursor to cross it once. This endpoint exists
 * so priming a large brain is something a user can actually do — call it
 * repeatedly and watch `seeds_examined` and `candidates_recorded` move.
 * These tests assert it reuses runInsightAccrual rather than reimplementing
 * it (same cursor, same eligibility rules), reports real counts rather than
 * a bare `ok: true`, and is gated behind the same auth every other admin
 * route uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleAdminRoutes } from "../../src/routes/admin";
import { req } from "../helpers/make-request";
import { makeInsightFixture, FIXTURE_NOW } from "../helpers/insight-fixture";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ACCRUAL_CURSOR_KEY, runInsightAccrual } from "../../src/insight/candidates";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const call = (env: any, token: string | null = "test-token") =>
  handleAdminRoutes(
    req("POST", "/insights/accrue", { token }),
    new URL("http://localhost/insights/accrue"),
    env,
    ctx,
  );

describe("POST /insights/accrue", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    resetDatabaseInit();
  });

  it("requires auth", async () => {
    const fx = makeInsightFixture();
    const res = await call(fx.env, null);
    expect(res?.status).toBe(401);
    fx.sqlite.close();
  });

  it("runs one accrual pass and reports seeds examined, candidates recorded, and the pending total", async () => {
    const fx = makeInsightFixture();

    const res = await call(fx.env);
    const body = await res!.json() as any;

    expect(body.ok).toBe(true);
    // Every entry the fixture seeds (4 planted + 5 decoys) is in one window,
    // well under ACCRUAL_SEED_LIMIT.
    expect(body.seeds_examined).toBe(fx.all.length);

    const recordedPairs = await fx.pairs();
    expect(body.candidates_recorded).toBe(recordedPairs.length);
    expect(body.candidates_recorded).toBeGreaterThan(0);
    expect(body.pending_total).toBe(recordedPairs.length);

    fx.sqlite.close();
  });

  it("reuses runInsightAccrual's own cursor — a second call sees a smaller window", async () => {
    const fx = makeInsightFixture();

    const first = await (await call(fx.env))!.json() as any;
    expect(first.seeds_examined).toBe(fx.all.length);
    expect(first.candidates_recorded).toBeGreaterThan(0);

    // The cursor now sits past every entry the fixture seeded, so a second
    // call — with nothing new written in between — examines nothing and
    // records nothing. This is what makes "call it repeatedly to prime a
    // large brain, stop once seeds_examined is small" true rather than
    // aspirational: it is the SAME cursor runInsightAccrual always used, not
    // a separate one this route made up.
    const second = await (await call(fx.env))!.json() as any;
    expect(second.seeds_examined).toBe(0);
    expect(second.candidates_recorded).toBe(0);
    expect(second.pending_total).toBe(first.candidates_recorded);

    fx.sqlite.close();
  });

  it("advances the same accrual cursor the nightly cron reads", async () => {
    const fx = makeInsightFixture();

    await call(fx.env);

    // Not a route-local cursor: the nightly cron and this endpoint must agree
    // on where accrual has gotten to, or priming via this endpoint would not
    // actually save the cron any work.
    const cursor = await fx.env.OAUTH_KV.get(ACCRUAL_CURSOR_KEY);
    expect(cursor).not.toBeNull();

    fx.sqlite.close();
  });
});

/**
 * runInsightAccrual() itself, against real SQLite rather than the
 * SQL-matching mock: the question is whether the two-sided authorship rule
 * (isEligiblePair, src/insight/candidates.ts) actually keeps a pair of
 * assistant-written memories out of insight_candidates, not just whether it
 * exists as an exported, unit-tested predicate nothing calls — a mock that
 * recognises the insert by substring would pass whether or not the guard
 * runs.
 */
async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase(makeTestEnv(s.db as any));
  return s;
}

/**
 * "a" and "b" as each other's only Vectorize neighbour, at a fixed high
 * score — similarity and the gap floor are not what these tests are about,
 * so both are made trivially satisfied and only the pair's authorship
 * changes between tests.
 */
function envOf(s: SqliteD1): Env {
  return makeTestEnv(s.db as any, {
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({
      getByIds: vi.fn().mockImplementation(async (ids: string[]) =>
        ids.map(id => ({ id, values: new Array(384).fill(0.1) }))),
      query: vi.fn().mockResolvedValue({
        matches: [
          { id: "a", score: 0.99, metadata: { parentId: "a" } },
          { id: "b", score: 0.99, metadata: { parentId: "b" } },
        ],
      }),
    }),
  });
}

const DAY = 86400000;

describe("runInsightAccrual() pair authorship rule", () => {
  let sq: SqliteD1 | null = null;

  afterEach(() => { sq?.close(); sq = null; });

  it("does not accrue a pair of two assistant-written memories", async () => {
    sq = await migrated();
    sq.seed({
      id: "a",
      content: "A long enough assistant note about the pricing model to clear the content floor for this accrual test case.",
      createdAt: 1000, tags: ["work", "claude-response"], vectorIds: ["a"],
    });
    sq.seed({
      id: "b",
      content: "Another long enough assistant note about the pricing model, written to clear that same content floor.",
      createdAt: 1000 + 40 * DAY, tags: ["work", "claude-response"], vectorIds: ["b"],
    });

    await runInsightAccrual(envOf(sq), ctx);

    const { results: rows } = await sq.db.prepare(
      "SELECT a_id, b_id FROM insight_candidates",
    ).all() as { results: unknown[] };
    expect(rows).toEqual([]);
  });

  it("still accrues an assistant note paired with a user memory", async () => {
    sq = await migrated();
    sq.seed({
      id: "a",
      content: "A long enough assistant note about the pricing model to clear the content floor for this accrual test case.",
      createdAt: 1000, tags: ["work", "claude-response"], vectorIds: ["a"],
    });
    sq.seed({
      id: "b",
      content: "A long enough memory the user wrote about the pricing model themselves, well past the content floor.",
      createdAt: 1000 + 40 * DAY, tags: ["work", "pricing"], vectorIds: ["b"],
    });

    await runInsightAccrual(envOf(sq), ctx);

    const { results: rows } = await sq.db.prepare(
      "SELECT a_id, b_id FROM insight_candidates",
    ).all() as { results: unknown[] };
    expect(rows.length).toBeGreaterThan(0);
  });
});
