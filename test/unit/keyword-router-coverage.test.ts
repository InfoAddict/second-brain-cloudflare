/**
 * Router coverage rule (T-0058 final fix): the cost estimate runs only when
 * distillation's df map covers EVERY retrieval token; a token without df keeps
 * FTS — even when the known df values alone exceed FTS_MATCH_BUDGET. This is
 * the rule the "treat unknown df as 0" mutation attacks. The distill module is
 * wrapped (the real scan runs, then one df entry is dropped) so the gap is
 * explicit instead of depending on cap-bound queries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { resetDistillTotalCache } from "../../src/recall/distill";
import { FTS_READY_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";
import type { RecallDiagnostics } from "../../src/recall/types";
import type * as DistillModule from "../../src/recall/distill";
import type { DistilledQuery, TimeBounds } from "../../src/recall/distill";
import type { Identity } from "../../src/lib/identity";
import type { Config } from "../../src/config";

// Hoisted so the vi.mock factory (which runs during module resolution) and the
// tests share one mutable holder for the term whose df entry is dropped.
const state = vi.hoisted(() => ({ dropDfFor: null as string | null }));

vi.mock("../../src/recall/distill", async (importOriginal) => {
  const actual = await importOriginal<typeof DistillModule>();
  return {
    ...actual,
    distillToRareTerms: vi.fn(
      async (
        query: string,
        env: Env,
        config?: Readonly<Config>,
        bounds?: Readonly<TimeBounds>,
        identity?: Identity,
        only?: "personal" | "company",
        teamId?: string,
      ): Promise<DistilledQuery> => {
        const distilled = await actual.distillToRareTerms(query, env, config, bounds, identity, only, teamId);
        if (state.dropDfFor && distilled.df) distilled.df.delete(state.dropDfFor);
        return distilled;
      },
    ),
  };
});

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

function recallEnv(sqlite: SqliteD1): Env {
  return makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) }),
  });
}

describe("keywordSearch's budget check needs df for every retrieval token", () => {
  let sqlite: SqliteD1;
  let env: Env;

  beforeEach(async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    resetDistillTotalCache();
    sqlite = makeSqliteD1();
    env = recallEnv(sqlite);
    await initializeDatabase(env);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    resetDistillTotalCache();
  });
  afterEach(() => {
    state.dropDfFor = null;
    sqlite.close();
  });

  it("keeps a query on FTS when one token's df is missing, though the known dfs alone exceed the budget", async () => {
    for (let i = 0; i < 2100; i++) sqlite.seed({ id: `row-${i}`, content: "widget gadget ledger", createdAt: i + 1 });

    // Real df: widget 2100, gadget 2100, ledger 2100 — the estimate would be
    // 6,300. Deleting ledger's entry leaves coverage incomplete, so the
    // estimate must not run at all: unknown df keeps FTS.
    state.dropDfFor = "ledger";

    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "widget gadget ledger", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsRoute).toBe("fts");
    expect(diagnostics.ftsUsed).toBe(true);
  });
});
