/**
 * GET /extract/dry-run — a preview of the when-extraction pass against real
 * data: same prefilter, same model call, nothing persisted, cursor untouched.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import { readWhenCursor } from "../../src/when/pass";
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

function makeAI(payload: string) {
  return {
    run: vi.fn().mockResolvedValue(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(payload)}}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    })),
  } as unknown as Ai;
}

function seedOpenLoop(s: SqliteD1, id: string, content: string, createdAt: number) {
  s.seed({ id, content, createdAt, tags: ["task"] });
}

describe("GET /extract/dry-run", () => {
  it("requires admin", async () => {
    sq = await migrated();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV(), AI: makeAI(`{"is_commitment": false}`) });
    const res = await worker.fetch(req("GET", "/extract/dry-run", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns a verdict per candidate without persisting or advancing the cursor", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "File the annual report", 1000);
    const env = makeTestEnv(dbOf(sq) as any, {
      OAUTH_KV: makeMemoryKV(),
      AI: makeAI(`{"is_commitment": true, "what": "File the report", "due_at": "2027-01-30", "confidence": 0.9}`),
    });

    const data = await (await worker.fetch(req("GET", "/extract/dry-run"), env, ctx)).json() as any;

    expect(data.candidates).toHaveLength(1);
    expect(data.candidates[0]).toMatchObject({
      id: "loop-1", outcome: "commitment", what: "File the report", confidence: 0.9,
    });

    const row = (await sq.db.prepare(`SELECT when_at, when_source FROM entries WHERE id = 'loop-1'`).first()) as any;
    expect(row.when_at).toBeNull();
    expect(row.when_source).toBeNull();
    expect(await readWhenCursor(env)).toBeNull();
  });

  it("reports a declined verdict with null what/due_at/confidence", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "Just checking in", 1000);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV(), AI: makeAI(`{"is_commitment": false}`) });

    const data = await (await worker.fetch(req("GET", "/extract/dry-run"), env, ctx)).json() as any;

    expect(data.candidates[0]).toEqual({
      id: "loop-1", content: "Just checking in", outcome: "declined", what: null, due_at: null, confidence: null,
    });
  });

  it("reports a failed verdict and keeps going to the rest of the window", async () => {
    sq = await migrated();
    seedOpenLoop(sq, "loop-1", "First", 1000);
    seedOpenLoop(sq, "loop-2", "Second", 2000);
    let calls = 0;
    const env = makeTestEnv(dbOf(sq) as any, {
      OAUTH_KV: makeMemoryKV(),
      AI: {
        run: vi.fn().mockImplementation(async () => {
          calls++;
          if (calls === 1) throw new Error("AI down");
          return new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(`data: {"response":"{\\"is_commitment\\": false}"}\n\n`));
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          });
        }),
      } as unknown as Ai,
    });

    const data = await (await worker.fetch(req("GET", "/extract/dry-run?limit=2"), env, ctx)).json() as any;

    expect(data.candidates.map((c: any) => c.outcome)).toEqual(["failed", "declined"]);
  });

  it("defaults to 5 and clamps a limit above 10", async () => {
    sq = await migrated();
    for (let i = 0; i < 12; i++) seedOpenLoop(sq, `loop-${i}`, `Candidate ${i}`, 1000 + i);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV(), AI: makeAI(`{"is_commitment": false}`) });

    const defaultRes = await (await worker.fetch(req("GET", "/extract/dry-run"), env, ctx)).json() as any;
    expect(defaultRes.candidates).toHaveLength(5);

    // intParam clamps rather than rejects (matches every sibling `limit`
    // param in this codebase, e.g. GET /stale).
    const tooMany = await (await worker.fetch(req("GET", "/extract/dry-run?limit=11"), env, ctx)).json() as any;
    expect(tooMany.candidates).toHaveLength(10);
  });
});
