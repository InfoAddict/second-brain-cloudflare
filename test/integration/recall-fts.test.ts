/**
 * Task 3 (#374 FTS5 lexical arm): keywordSearch's FTS path with LIKE fallback.
 *
 * The dense arm is forced down (VECTORIZE.query rejects) so the keyword arm's
 * SQL is the entire candidate source, same idiom as
 * test/integration/team-recall-scoping.test.ts. These run against real SQLite
 * (test/helpers/sqlite-d1.ts) because the thing under test — bm25 ranking,
 * trigram substring matching, scope/time SQL against entries_fts — cannot be
 * evaluated by the D1 mock's string matcher.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { DEFAULTS } from "../../src/config";
import { CJK_RECALL_FIXTURE } from "../fixtures/cjk-recall";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";
import type { RecallDiagnostics, RecallInternalOptions } from "../../src/recall/types";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

/** Dense arm always fails: the keyword arm's SQL becomes the entire candidate source. */
function recallEnv(sqlite: SqliteD1): Env {
  return makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) }),
  });
}

const memberOf = (personal: string): Identity => ({
  userId: "u1",
  role: "member",
  personalWorkspaceId: personal,
  companyWorkspaceIds: ["ws-co"],
  defaultShare: "" as const,
});

/** Seed through the normal insert, then relocate — mirrors team-recall-scoping.test.ts. */
function seedIn(sqlite: SqliteD1, id: string, workspaceId: string, content: string, createdAt: number) {
  sqlite.seed({ id, content, createdAt });
  sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
}

describe("recall keyword arm: FTS5 with LIKE fallback", () => {
  let sqlite: SqliteD1;
  let env: Env;

  beforeEach(async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    sqlite = makeSqliteD1();
    env = recallEnv(sqlite);
    await initializeDatabase(env);
    sqlite.issued.length = 0; // init's own DDL is not part of what these tests assert on
  });
  afterEach(() => sqlite.close());

  it("selects candidates by relevance, not recency", async () => {
    // Three recent rows share the query term once amid a long filler body (low
    // bm25); one very old row repeats the term in a short body (high bm25).
    // LIKE + ORDER BY created_at DESC LIMIT 3 keeps the three recent rows and
    // drops the old one; FTS + bm25 LIMIT 3 keeps the old one instead.
    const now = 2_000_000;
    sqlite.seed({ id: "recentA", content: "the widget shipped to customer alpha along with many other long descriptive words filler filler filler filler filler filler", createdAt: now });
    sqlite.seed({ id: "recentB", content: "the widget shipped to customer beta along with many other long descriptive words filler filler filler filler filler filler", createdAt: now - 1000 });
    sqlite.seed({ id: "recentC", content: "the widget shipped to customer gamma along with many other long descriptive words filler filler filler filler filler filler", createdAt: now - 2000 });
    sqlite.seed({ id: "oldRare", content: "widget widget widget", createdAt: now - 1_000_000 });

    const cfg = { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: 3 };

    const likeDiagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "widget", topK: 10, synthesize: false }, env, ctx, cfg, { diagnostics: likeDiagnostics });
    expect(likeDiagnostics.ftsUsed).toBe(false);
    expect(likeDiagnostics.keywordIds).not.toContain("oldRare");

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const ftsDiagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "widget", topK: 10, synthesize: false }, env, ctx, cfg, { diagnostics: ftsDiagnostics });
    expect(ftsDiagnostics.ftsUsed).toBe(true);
    expect(ftsDiagnostics.keywordIds).toContain("oldRare");
  });

  it("matches CJK substrings through the trigram index", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    // jp-29's query tokens ("データベース", "バックアップ") are both >= 3
    // codepoints, so they survive the trigram floor — unlike most of this
    // fixture's 2-character word segments (see jp-01/jp-02, used as distractors).
    const target = CJK_RECALL_FIXTURE.find(item => item.id === "jp-29")!;
    const distractorA = CJK_RECALL_FIXTURE.find(item => item.id === "jp-01")!;
    const distractorB = CJK_RECALL_FIXTURE.find(item => item.id === "jp-02")!;
    let t = 1000;
    for (const item of [target, distractorA, distractorB]) sqlite.seed({ id: item.id, content: item.content, createdAt: t++ });

    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: target.query, topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(true);
    expect(sqlite.issued.some(sql => sql.includes("entries_fts"))).toBe(true);
    expect(res.matches[0]?.id).toBe(target.id);
  });

  it("applies time bounds and tenancy scope to FTS results", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const now = 100_000;
    seedIn(sqlite, "in-scope", "ws-a", "quarterly roadmap notes", now);
    seedIn(sqlite, "foreign", "ws-b", "quarterly roadmap notes", now);
    seedIn(sqlite, "too-old", "ws-a", "quarterly roadmap notes", now - 100_000);

    const diagnostics: RecallDiagnostics = {};
    const internal: RecallInternalOptions = { identity: memberOf("ws-a"), diagnostics };
    await recallEntries({ query: "roadmap", topK: 10, after: now - 1000, synthesize: false }, env, ctx, undefined, internal);

    expect(diagnostics.ftsUsed).toBe(true);
    expect(diagnostics.keywordIds).toEqual(["in-scope"]);
  });

  it("falls back to LIKE when the FTS query throws", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    sqlite.seed({ id: "e1", content: "fallback safety content", createdAt: 1000 });
    await sqlite.db.exec(`DROP TABLE entries_fts`);

    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: "fallback", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(false);
    expect(res.matches.map(m => m.id)).toContain("e1");
  });

  it("stays on LIKE when the ready flag is absent", async () => {
    sqlite.seed({ id: "e1", content: "default path content", createdAt: 1000 });

    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: "default", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(false);
    expect(res.matches.map(m => m.id)).toContain("e1");
    expect(sqlite.issued.some(sql => sql.includes("entries_fts"))).toBe(false);
  });
});
