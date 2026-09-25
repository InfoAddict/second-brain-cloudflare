/**
 * Agents ask the brain in frames ("User wants to X about Y — what should I know?"). The frame's words are in many rows
 * (sessions, requests, retrospectives), and a row that echoes several of them weighed more than the one row holding the
 * subject's rare name. The subject must win on both keyword routes (FTS ready or not).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import { distillToRareTerms } from "../../src/recall/distill";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
let sqlite: SqliteD1;

const echo = (i: number) => `Session ${i}: the user wants a summary, we tried the export before, and I should know the status; nothing else.`;

function seed() {
  sqlite.seed({ id: "gold", content: "Kobrelune is our tiny internal chat bot; it posts the lunch order at eleven.", createdAt: 1_000 });
  for (let i = 0; i < 60; i++) sqlite.seed({ id: `echo-${i}`, content: echo(i), createdAt: 50_000 + i });
  for (let i = 0; i < 240; i++) sqlite.seed({ id: `filler-${i}`, content: `Bought groceries and cleaned the garage, note number ${i}.`, createdAt: 10_000 + i });
}

async function recall(query: string, ftsReady: boolean, dense: string[] = []) {
  resetDatabaseInit();
  resetFtsReadyMemo();
  const kv = makeMemoryKV();
  const env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: kv,
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: dense.map((id, i) => ({ id, score: 0.9 - i * 0.01, metadata: { parentId: id, created_at: 50_000 } })) }) }),
  }) as Env;
  if (ftsReady) { await kv.put(FTS_READY_KV_KEY, "1"); resetFtsReadyMemo(); }
  const diagnostics: RecallDiagnostics = {};
  const res = await recallEntries({ query, topK: 10, synthesize: false }, env, ctx, { ...DEFAULTS }, { diagnostics });
  return { ids: res.matches.map(m => m.id), diagnostics, env };
}

beforeEach(async () => {
  resetDatabaseInit();
  resetFtsReadyMemo();
  sqlite = makeSqliteD1();
  await initializeDatabase(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }) as Env);
  seed();
});
afterEach(() => sqlite.close());

const FRAMED = [
  "User wants to check on Kobrelune — what have we tried before?",
  "User wants to know about Kobrelune — what should I know?",
  "Tell me all about Kobrelune",
  "User is about to use Kobrelune — have I recommended this before or has it been done?",
];

describe("agent-framed queries", () => {
  for (const ftsReady of [true, false]) {
    for (const query of FRAMED) {
      it(`put the row holding the subject first (${ftsReady ? "FTS" : "LIKE"}): ${query}`, async () => {
        const { ids, diagnostics } = await recall(query, ftsReady, Array.from({ length: 12 }, (_, i) => `echo-${i}`));
        expect(diagnostics.ftsRoute).toMatch(ftsReady ? /^fts/ : /^like/);
        expect(ids[0]).toBe("gold");
      });
    }
  }

  it("distills to the subject, not to the scaffolding", async () => {
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }) as Env;
    const { query } = await distillToRareTerms("User wants to check on Kobrelune — what have we tried before?", env);
    expect(query.toLowerCase()).toContain("kobrelune");
    for (const frame of ["user", "wants", "tried"]) expect(query.toLowerCase()).not.toContain(frame);
  });

  it("finds a bare rare term (\"gatewright\", \"SciFact\") ahead of dense neighbours that merely sit near it", async () => {
    for (const ftsReady of [true, false]) {
      const { ids } = await recall("Kobrelune", ftsReady, Array.from({ length: 12 }, (_, i) => `echo-${i}`));
      expect(ids[0], ftsReady ? "FTS" : "LIKE").toBe("gold");
    }
  });
});
