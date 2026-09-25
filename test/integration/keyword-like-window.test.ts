/**
 * The LIKE keyword arm keeps the newest KEYWORD_CANDIDATE_LIMIT rows matching ANY query term. A conversational query
 * ("Tell me all about <name>") carries a word most rows contain ("all"), so that window fills with recent rows that
 * match only the common word and an old note holding the rare name never reaches fusion. Rows carrying the rarest
 * terms must survive the window whenever they fit it; only the slots they leave go to recency.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { keywordSearch, recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const LIMIT = 50;
const NAME_IDS = ["name-0", "name-1", "name-2"];

let sqlite: SqliteD1;
let env: Env;

const likeStatements = () => [...sqlite.issued, ...sqlite.batches.flat()]
  .filter(sql => sql.includes("FROM entries WHERE") && sql.includes("content LIKE") && sql.includes("ORDER BY created_at DESC"));

/** 3 old notes with the name; 40 recent notes with "tell"; 120 recent notes with "all" (nearly every row has it). */
function seedBrain() {
  NAME_IDS.forEach((id, i) => sqlite.seed({ id, content: `Zorvane works at the harbour office (${i}).`, createdAt: 1_000 + i }));
  for (let i = 0; i < 120; i++) sqlite.seed({ id: `all-${i}`, content: `We went over all of it again, note ${i}.`, createdAt: 100_000 + i });
  for (let i = 0; i < 40; i++) sqlite.seed({ id: `tell-${i}`, content: `Remember to tell them about the plan at all, note ${i}.`, createdAt: 200_000 + i });
}

async function recall(query: string, dense: { id: string; score: number }[] = []) {
  const e = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: dense.map(m => ({ ...m, metadata: { parentId: m.id, created_at: 200_000 } })) }) }),
  }) as Env;
  const diagnostics: RecallDiagnostics = {};
  const res = await recallEntries({ query, topK: 10, synthesize: false }, e, ctx, { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: LIMIT }, { diagnostics });
  return { ids: res.matches.map(m => m.id), diagnostics };
}

beforeEach(async () => {
  resetDatabaseInit();
  resetFtsReadyMemo();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }) as Env;
  await initializeDatabase(env); // no FTS ready flag: the keyword arm is the LIKE window
  resetFtsReadyMemo();
  seedBrain();
  sqlite.issued.length = 0;
  sqlite.batches.length = 0;
});
afterEach(() => sqlite.close());

describe("LIKE keyword window", () => {
  it("keeps the old rare-name notes for a conversational query, though the common word alone would fill the window", async () => {
    const { ids, diagnostics } = await recall("Tell me all about Zorvane");
    expect(diagnostics.ftsRoute).toBe("like-not-ready");
    for (const id of NAME_IDS) expect(diagnostics.keywordIds, id).toContain(id);
    expect(ids.slice(0, 3).sort()).toEqual(NAME_IDS);
  });

  it("still finds them when the dense arm returns only the recent notes", async () => {
    const dense = Array.from({ length: 15 }, (_, i) => ({ id: `tell-${39 - i}`, score: 0.9 - i * 0.01 }));
    const { ids } = await recall("Tell me all about Zorvane", dense);
    expect(ids.slice(0, 3).sort()).toEqual(NAME_IDS);
  });

  it("agrees with the same question asked without the filler words", async () => {
    const withFiller = (await recall("Tell me all about Zorvane")).ids.slice(0, 3).sort();
    const bare = (await recall("Zorvane")).ids.slice(0, 3).sort();
    expect(withFiller).toEqual(bare);
  });

  it("fills the slots the rare rows leave with the newest rows for the common words", async () => {
    const { diagnostics } = await recall("Tell me all about Zorvane");
    expect(diagnostics.keywordIds!.length).toBe(LIMIT);
    // 3 name rows + 40 tell rows fit the limit whole; the 7 remaining slots go to the newest "all" rows
    expect(diagnostics.keywordIds).toContain("tell-0");
    expect(diagnostics.keywordIds).toContain("all-119");
  });

  it("issues one recency-window statement when every term fits the limit, as before", async () => {
    await recall("Zorvane tell");
    expect(likeStatements()).toHaveLength(1);
  });

  it("changes nothing when the corpus frequencies are unknown", async () => {
    const rows = await keywordSearch(["tell", "zorvane", "all"], env, LIMIT, {}, undefined, undefined, undefined, undefined);
    expect(rows.route).toBe("like-not-ready");
    expect(rows.rows.map(r => r.id)).not.toContain("name-0"); // today's behavior, kept when nothing says which term is rare
    expect(likeStatements()).toHaveLength(1);
  });
});

describe("FTS keyword arm on the same shape (guard: it ranks by bm25, so it never had this problem)", () => {
  it("keeps the rare-name notes for a conversational query on a brain past the match budget", async () => {
    sqlite.close();
    resetDatabaseInit();
    resetFtsReadyMemo();
    sqlite = makeSqliteD1();
    const kv = makeMemoryKV();
    env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: kv }) as Env;
    await initializeDatabase(env);
    await kv.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    NAME_IDS.forEach((id, i) => sqlite.seed({ id, content: `Zorvane works at the harbour office (${i}).`, createdAt: 1_000 + i }));
    for (let i = 0; i < 2500; i++) sqlite.seed({ id: `all-${i}`, content: `We went over all of it again, note ${i}.`, createdAt: 100_000 + i });
    for (let i = 0; i < 600; i++) sqlite.seed({ id: `tell-${i}`, content: `Remember to tell them about the plan at all, note ${i}.`, createdAt: 200_000 + i });
    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: "Tell me all about Zorvane", topK: 10, synthesize: false }, env, ctx, { ...DEFAULTS }, { diagnostics });
    expect(diagnostics.ftsRoute).toMatch(/^fts/);
    expect(res.matches.slice(0, 3).map(m => m.id).sort()).toEqual(NAME_IDS);
  });
});
