/**
 * GET /insights/dry-run — a preview of the weekly pass that writes nothing.
 *
 * Ships ahead of the weekly writer being enabled: the design was validated
 * against one brain that is not representative, so before the writer ever
 * touches real data, a human needs to read what it would have said. That
 * only works if this endpoint truly writes nothing and never hides a
 * declined candidate — both are asserted directly below, not inferred from
 * the response shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { req } from "../helpers/make-request";
import { handleAdminRoutes } from "../../src/routes/admin";

const DAY = 86400000;
const NOW = 400 * DAY;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const GOOD = `{"insight": true, "shape": "contradiction", "text": "You set the pricing model flat and later moved it to usage-based billing."}`;

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

const call = (env: any, path: string, token: string | null = "test-token") =>
  handleAdminRoutes(req("GET", path, { token }), new URL(`http://localhost${path}`), env, ctx);

describe("GET /insights/dry-run", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    sqlite = makeSqliteD1();
    sqlite.seed({
      id: "a-1", createdAt: NOW - 120 * DAY, tags: ["pricing"],
      content: "Decision: price the first tier flat at nine dollars a month for predictability.",
    });
    sqlite.seed({
      id: "b-1", createdAt: NOW, tags: ["pricing"],
      content: "Decision: move the first tier to usage-based billing instead of flat pricing.",
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('c-1', 'a-1', 'b-1', 0.87, ?, 4.2, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, NOW).run();
  });

  afterEach(() => sqlite.close());

  it("requires auth", async () => {
    const env = makeTestEnv(undefined, { DB: sqlite.db as any, OAUTH_KV: makeMemoryKV() });
    const res = await call(env, "/insights/dry-run", null);
    expect(res?.status).toBe(401);
  });

  it("returns reasoned candidates", async () => {
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD),
      OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    const body = await (await call(env, "/insights/dry-run"))!.json() as any;

    expect(body.ok).toBe(true);
    expect(body.candidates[0].shape).toBe("contradiction");
    expect(body.candidates[0].a_id).toBe("a-1");
  });

  it("writes nothing at all", async () => {
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD),
      OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    await call(env, "/insights/dry-run");

    const insights = await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%'`,
    ).first() as { n: number };
    const status = await sqlite.db.prepare(
      `SELECT status FROM insight_candidates WHERE id = 'c-1'`,
    ).first() as { status: string };

    expect(insights.n).toBe(0);
    expect(status.status).toBe("pending");
  });

  it("reports a declined candidate as having no insight", async () => {
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(`{"insight": false}`),
      OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    const body = await (await call(env, "/insights/dry-run"))!.json() as any;

    expect(body.candidates[0].shape).toBeNull();
    expect(body.candidates[0].text).toBeNull();
  });
});
