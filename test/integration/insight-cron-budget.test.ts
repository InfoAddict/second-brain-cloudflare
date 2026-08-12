import { describe, it, expect, vi, beforeEach } from "vitest";
import { runInsightAccrual, ACCRUAL_SEED_LIMIT } from "../../src/insight/candidates";
import { runWeeklyInsights, WEEKLY_CANDIDATE_LIMIT, MAX_INSIGHTS_PER_RUN } from "../../src/insight/weekly";
import { resetDatabaseInit } from "../../src/db/init";
import { makeInsightFixture, FIXTURE_NOW } from "../helpers/insight-fixture";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";

/**
 * A Worker invocation gets 50 D1 subrequests on the free plan, and every
 * binding call counts against it — D1, Vectorize, Workers AI and KV alike.
 * `sqlite.issued` records one entry per D1 call, including one per batch;
 * the other three are counted directly off each mock's own call log below.
 */
const SUBREQUEST_BUDGET = 50;

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const DAY = 86400000;

/**
 * A reasoning call that always accepts. The default AI mock (makeAIMock in
 * test/helpers/make-env.ts) returns the literal text "3" for every non-embedding
 * call, which parseInsightResponse (src/insight/reason.ts) can never parse as
 * JSON — so with the default mock reasonOverPair returns null for every
 * candidate and captureEntry is never reached at all. That measures the cheap
 * branch of the weekly pass (rejections only), not the expensive one: up to
 * MAX_INSIGHTS_PER_RUN real captures, each paying duplicate detection,
 * embedding and storage. This mock (same shape as test/unit/insight-weekly.
 * test.ts's makeAI) answers the reasoning prompt — identified by "Memory A:",
 * the one string only that prompt contains — with a well-formed insight, so
 * the pass actually exercises captureEntry the number of times production
 * would on a night where every candidate is a real one.
 */
function makeReasoningAI() {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      // Keyed off the candidate's own tier number so every accepted insight's
      // text — and therefore captureEntry's stored content — is distinct per
      // candidate, not a repeat of the same string three times over.
      const tier = prompt.match(/tier (\d+)/)?.[1] ?? "0";
      const insight = `{"insight": true, "shape": "contradiction", "text": "You priced tier ${tier} at nine dollars flat, then moved tier ${tier} to usage-based pricing instead."}`;
      return sse(prompt.includes("Memory A:") ? insight : "3");
    }),
  } as unknown as Ai;
}

describe("insight crons stay inside one invocation's budget", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    // initializeDatabase memoizes its promise at module scope (src/db/init.ts).
    // Every test here builds a brand-new in-memory database, so without this
    // reset the second test to reach a runtime-ALTER column (captureEntry's
    // INSERT below writes updated_at, which lives only in the ALTER, not in
    // db/schema.sql) inherits an "already migrated" memo for a database that
    // was never altered, and the insert fails against real SQLite.
    resetDatabaseInit();
  });

  it("accrual stays under budget at a full seed batch", async () => {
    // The fixture holds a handful of entries; a real night can present
    // ACCRUAL_SEED_LIMIT of them, so pad it to the worst case.
    //
    // Padding with a vector id the fixture's VECTORIZE mock has never heard of
    // (e.g. `vec-pad-${i}`) makes getByIds silently drop it — the mock's
    // getByIds filters to ids it recognises — so the padded seed never reaches
    // a query() call at all, and the measured run is dominated by the handful
    // of real fixture entries rather than a full 25-seed batch. Pointing each
    // pad entry's vector id at one of the fixture's own (real, registered)
    // vectors keeps every padded seed resolvable, so this actually drives
    // ACCRUAL_SEED_LIMIT worth of VECTORIZE.query calls — the cost line item
    // that dominates the budget (see src/insight/candidates.ts's own comment:
    // "25 queries" of the ~34 total) — rather than measuring a run that quietly
    // does almost nothing.
    const fx = makeInsightFixture();
    for (let i = 0; i < ACCRUAL_SEED_LIMIT; i++) {
      fx.sqlite.seed({
        id: `pad-${i}`, createdAt: FIXTURE_NOW - i * DAY, tags: ["pricing"],
        content: `A padding decision about the pricing model number ${i}, long enough to be eligible.`,
        vectorIds: [`vec-${fx.all[i % fx.all.length].id}`],
      });
    }
    // The fixture's KV (test/helpers/make-env.ts's makeMemoryKV) is a plain
    // object, not a vi.fn(), so its calls have to be spied on explicitly —
    // runInsightAccrual reads and writes the accrual cursor through it, and
    // that read/write is as real a subrequest as a D1 or Vectorize call.
    const kvGet = vi.spyOn(fx.env.OAUTH_KV, "get");
    const kvPut = vi.spyOn(fx.env.OAUTH_KV, "put");

    await runInsightAccrual(fx.env, ctx);

    const bindingCalls =
      (fx.env.VECTORIZE.query as any).mock.calls.length +
      (fx.env.VECTORIZE.getByIds as any).mock.calls.length +
      kvGet.mock.calls.length +
      kvPut.mock.calls.length;
    expect(fx.sqlite.issued.length + bindingCalls).toBeLessThan(SUBREQUEST_BUDGET);
    fx.sqlite.close();
  });

  it("the weekly pass stays under budget at a full candidate slate", async () => {
    // Every candidate content string is parameterised by `i` so that, once
    // reasoning starts accepting (below), the entries captureEntry writes are
    // not identical to one another — an identical-content run would let
    // duplicate detection block the second and third capture, which would
    // measure that path's cost instead of three genuinely separate writes.
    const sqlite: SqliteD1 = makeSqliteD1();
    for (let i = 0; i < WEEKLY_CANDIDATE_LIMIT; i++) {
      sqlite.seed({
        id: `a-${i}`, createdAt: FIXTURE_NOW - 120 * DAY, tags: ["pricing"],
        content: `Decision: price tier ${i} flat at nine dollars a month for predictable billing.`,
      });
      sqlite.seed({
        id: `b-${i}`, createdAt: FIXTURE_NOW, tags: ["pricing"],
        content: `Decision: move tier ${i} to usage-based billing instead of flat pricing.`,
      });
      sqlite.db.prepare(
        `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
      ).bind(`c-${i}`, `a-${i}`, `b-${i}`, 120 * DAY, 10 - i, FIXTURE_NOW).run();
    }
    const before = sqlite.issued.length;   // seeding is not the pass

    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: kv, VECTORIZE: makeVectorizeMock(),
      AI: makeReasoningAI(),
    });
    // Same reasoning as the accrual test: KV is a plain object, not a vi.fn(),
    // so it needs an explicit spy. runWeeklyInsights itself reads it once
    // (config, via resolveConfig) — but each successful captureEntry call
    // fires its own KV read too, for the tag-vocabulary cache (rememberTags,
    // src/tags/vocabulary.ts), via a fire-and-forget ctx.waitUntil() call
    // whose body still runs (and still spends the read) synchronously up to
    // its first await regardless of whether anything ever awaits the result.
    // Measured: 1 config read + 3 vocabulary reads (one per capture) = 4.
    const kvGet = vi.spyOn(kv, "get");
    const kvPut = vi.spyOn(kv, "put");

    await runWeeklyInsights(env, ctx);

    // Confirms this actually measured the expensive branch (real captures)
    // rather than the cheap one (every candidate declined) — otherwise the
    // budget assertion below would hold trivially, the way it did against
    // the default AI mock.
    const written = (await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%'`,
    ).first()) as { n: number };
    expect(written.n).toBe(MAX_INSIGHTS_PER_RUN);

    const bindingCalls =
      (env.AI.run as any).mock.calls.length +
      (env.VECTORIZE.query as any).mock.calls.length +
      // captureEntry's storage path calls VECTORIZE.upsert, not .insert
      // (src/capture/store.ts) — counting only .insert left the actual
      // vector write completely untracked. Both are counted, rather than
      // one replacing the other, so this stays correct if that ever changes.
      (env.VECTORIZE.insert as any).mock.calls.length +
      (env.VECTORIZE.upsert as any).mock.calls.length +
      kvGet.mock.calls.length +
      kvPut.mock.calls.length;
    expect((sqlite.issued.length - before) + bindingCalls).toBeLessThan(SUBREQUEST_BUDGET);
    sqlite.close();
  });
});
