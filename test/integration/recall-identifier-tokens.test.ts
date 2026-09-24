import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { distillToRareTerms } from "../../src/recall/distill";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { recallEntries } from "../../src/recall/search";
import { FTS_READY_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

describe("literal identifier tokens in SQLite recall", () => {
  let sqlite: SqliteD1;
  let env: Env;

  beforeEach(async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) }),
    });
    await initializeDatabase(env);
  });
  afterEach(() => sqlite.close());

  async function search(query: string, fts: boolean): Promise<RecallDiagnostics> {
    if (fts) await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    else await env.OAUTH_KV.delete(FTS_READY_KV_KEY);
    resetFtsReadyMemo();
    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query, topK: 10, synthesize: false }, env, ctx, undefined, { diagnostics });
    expect(diagnostics.ftsUsed).toBe(fts);
    return diagnostics;
  }

  for (const fts of [false, true]) {
    const route = fts ? "FTS" : "LIKE";
    it(`finds literal underscores and percent signs through ${route}`, async () => {
      const identifiers = ["ERR_TLS_90412", "DATABASE_URL", "reconcile_ledger_batch_v2", "50%_off", "path\\name"];
      for (const [i, identifier] of identifiers.entries()) {
        sqlite.seed({ id: `hit-${i}`, content: `Configuration value ${identifier} was recorded`, createdAt: i + 1 });
      }
      for (const [i, identifier] of ["ERRTLS90412", "DATABASEXURL", "reconcileXledgerXbatchXv2", "50Xoff", "pathXname"].entries()) {
        sqlite.seed({ id: `decoy-${i}`, content: `Configuration value ${identifier} was recorded`, createdAt: i + 10 });
      }
      for (const [i, identifier] of identifiers.entries()) {
        const diagnostics = await search(identifier, fts);
        expect(diagnostics.keywordIds).toContain(`hit-${i}`);
        expect(diagnostics.keywordIds).not.toContain(`decoy-${i}`);
      }
    });

    it(`keeps underscore literal and edge percent compatible through ${route}`, async () => {
      sqlite.seed({ id: "underscore", content: "the a_c setting", createdAt: 1 });
      sqlite.seed({ id: "underscore-decoy", content: "the abc setting", createdAt: 2 });
      sqlite.seed({ id: "percent", content: "a 100% rebate", createdAt: 3 });
      sqlite.seed({ id: "percent-decoy", content: "a 1000 rebate", createdAt: 4 });
      sqlite.seed({ id: "percent-words", content: "a 100 percent rebate", createdAt: 5 });
      sqlite.seed({ id: "unrelated", content: "an unrelated rebate", createdAt: 6 });
      expect((await search("a_c", fts)).keywordIds).toEqual(["underscore"]);
      expect([...(await search("100%", fts)).keywordIds!].sort())
        .toEqual(["percent", "percent-decoy", "percent-words"]);
    });
  }

  it("keeps an ordinary percent query on FTS", async () => {
    sqlite.seed({ id: "apr", content: "9% APR financing", createdAt: 1 });
    const diagnostics = await search("9% APR", true);
    expect(diagnostics.ftsRoute).toBe("fts");
    expect(diagnostics.keywordIds).toContain("apr");
  });

  it("does not let punctuation-only terms demote FTS", async () => {
    sqlite.seed({ id: "apr", content: "APR financing", createdAt: 1 });
    const diagnostics = await search("___ %% _% APR", true);
    expect(diagnostics.ftsRoute).toBe("fts");
    expect(diagnostics.keywordIds).toEqual(["apr"]);
  });

  it("counts literal tokens in the LIKE document-frequency scan", async () => {
    sqlite.seed({ id: "exact", content: "ERR_TLS_90412 50%_off completed", createdAt: 1 });
    sqlite.seed({ id: "decoy", content: "ERRXTLSX90412 50Xoff completed", createdAt: 2 });
    const result = await distillToRareTerms("ERR_TLS_90412 50%_off", env);
    expect(result.distillSource).toBe("like");
    expect(result.df?.get("err_tls_90412")).toBe(1);
    expect(result.df?.get("50%_off")).toBe(1);
  });

  it("counts literal tokens in the FTS document-frequency scan", async () => {
    sqlite.seed({ id: "exact", content: "ERR_TLS_90412 50%_off completed", createdAt: 1 });
    sqlite.seed({ id: "decoy", content: "ERRXTLSX90412 50Xoff completed", createdAt: 2 });
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const result = await distillToRareTerms("ERR_TLS_90412 50%_off", env);
    expect(result.distillSource).toBe("fts");
    expect(result.df?.get("err_tls_90412")).toBe(1);
    expect(result.df?.get("50%_off")).toBe(1);
  });

  it("routes a high document-frequency sum for underscored terms to LIKE", async () => {
    for (let i = 0; i < 1050; i++) {
      sqlite.seed({ id: `row-${i}`, content: "ERR_TLS_90412 DATABASE_URL", createdAt: i + 1 });
    }
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "ERR_TLS_90412 DATABASE_URL", topK: 10, synthesize: false }, env, ctx, undefined, { diagnostics });
    expect(diagnostics.ftsRoute).toBe("like-match-budget");
    expect(diagnostics.ftsUsed).toBe(false);
    expect(diagnostics.keywordIds).toContain("row-1049");
  });
});
