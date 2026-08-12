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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAdminRoutes } from "../../src/routes/admin";
import { req } from "../helpers/make-request";
import { makeInsightFixture, FIXTURE_NOW } from "../helpers/insight-fixture";
import { resetDatabaseInit } from "../../src/db/init";
import { ACCRUAL_CURSOR_KEY } from "../../src/insight/candidates";

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
