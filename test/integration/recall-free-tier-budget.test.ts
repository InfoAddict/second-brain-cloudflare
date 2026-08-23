import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { TAG_VOCABULARY_KEY } from "../../src/tags/vocabulary";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { snapshotRecallBudget } from "../helpers/recall-budget";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

describe("recall stays within the Cloudflare Free operation envelope", () => {
  const open: SqliteD1[] = [];
  afterEach(() => open.splice(0).forEach(sqlite => sqlite.close()));

  async function run(hops: 0 | 1) {
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    await sqlite.db.prepare(`ALTER TABLE entries ADD COLUMN updated_at INTEGER`).run();
    sqlite.seed({ id: "root", content: "atlas ledger changed", createdAt: 1000, tags: ["work"] });
    if (hops) {
      sqlite.seed({ id: "neighbor", content: "reconciliation rationale", createdAt: 1001, tags: ["work"] });
      await sqlite.db.prepare(
        `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind("edge", "root", "neighbor", "decided", 1, "explicit", "{}", 1, 1).run();
    }

    const kv = makeMemoryKV();
    await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["work"], rebuiltAt: Date.now() }));
    const vectorQuery = vi.fn().mockResolvedValue({
      matches: [{ id: "root", score: .9, metadata: { parentId: "root", created_at: 1000 } }],
    });
    const env: Env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
    });
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => deferred.push(promise) } as unknown as ExecutionContext;
    const diagnostics: RecallDiagnostics = {};

    const result = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops, synthesize: false },
      env,
      ctx,
      DEFAULTS,
      { diagnostics },
    );
    await Promise.all(deferred);
    return snapshotRecallBudget(diagnostics, result);
  }

  it("charges one existing operation path for direct recall", async () => {
    const budget = await run(0);

    expect(budget).toMatchObject({
      workerRequests: 1,
      // Existing behavior: one embedding plus one tag-inference LLM because
      // the warm vocabulary has no literal query match. Recovery may not add a
      // third call.
      aiCalls: 2,
      embeddingCalls: 1,
      vectorizeQueries: 1,
      vectorizeGets: 0,
      kvReads: 1,
      kvWrites: 0,
      graphSeeds: 0,
      expandedNodes: 0,
      renderedResults: 1,
    });
    expect(budget.d1Statements).toBe(5);
    expect(budget.d1Statements).toBeLessThanOrEqual(30);
    // D1's first() response omits metadata, so a complete per-invocation row
    // total is unknowable and must not be reported as a fabricated number.
    expect(budget.d1RowsRead).toBeNull();
    expect(budget.d1RowsWritten).toBeNull();
  });

  it("adds graph reads but no extra AI, embedding, or Vectorize path", async () => {
    const budget = await run(1);

    expect(budget.aiCalls).toBe(2);
    expect(budget.embeddingCalls).toBe(1);
    expect(budget.vectorizeQueries).toBe(1);
    expect(budget.vectorizeGets).toBe(0);
    expect(budget.kvReads).toBe(1);
    expect(budget.kvWrites).toBe(0);
    expect(budget.workerRequests).toBe(1);
    expect(budget.graphSeeds).toBe(1);
    expect(budget.expandedNodes).toBe(1);
    expect(budget.renderedResults).toBeLessThanOrEqual(5);
    expect(budget.d1Statements).toBe(7);
    expect(budget.d1Statements).toBeLessThanOrEqual(30);
    expect(budget.d1RowsRead).toBeNull();
    expect(budget.d1RowsWritten).toBeNull();
  });
});
