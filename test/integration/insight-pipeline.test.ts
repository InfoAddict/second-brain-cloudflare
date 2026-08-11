import { describe, it, expect, vi, beforeEach } from "vitest";
import { runInsightAccrual } from "../../src/insight/candidates";
import { resetDatabaseInit } from "../../src/db/init";
import { makeInsightFixture, FIXTURE_NOW } from "../helpers/insight-fixture";

const DAY = 86400000;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const involves = (pairs: string[], id: string) => pairs.some(p => p.split("|").includes(id));

type Fixture = ReturnType<typeof makeInsightFixture>;

/**
 * One candidate row's stored similarity/gap/score, by the two entries it
 * pairs — whichever order `normalisePair` put them in `a_id`/`b_id`.
 */
async function rowFor(
  sqlite: Fixture["sqlite"], aId: string, bId: string,
): Promise<{ similarity: number; gap_ms: number; score: number } | null> {
  const [x, y] = [aId, bId].sort();
  return (await sqlite.db.prepare(
    `SELECT similarity, gap_ms, score FROM insight_candidates WHERE a_id = ? AND b_id = ?`,
  ).bind(x, y).first()) as { similarity: number; gap_ms: number; score: number } | null;
}

describe("insight pipeline against a fixture brain", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    // initializeDatabase() memoizes its promise at module scope (src/db/init.ts);
    // each test here gets a brand new :memory: database via makeInsightFixture(),
    // so without this reset a later test's runInsightAccrual call would skip
    // migration against a database the memo has no way of knowing is different.
    resetDatabaseInit();
  });

  it("accrues the planted contradiction pair", async () => {
    const fx = makeInsightFixture();
    await runInsightAccrual(fx.env, ctx);

    const pairs = await fx.pairs();
    expect(pairs).toContain("plant-contradiction-new|plant-contradiction-old");
    fx.sqlite.close();
  });

  it("accrues the planted cross-topic connection", async () => {
    const fx = makeInsightFixture();
    await runInsightAccrual(fx.env, ctx);

    const pairs = await fx.pairs();
    expect(pairs).toContain("plant-connection-a|plant-connection-b");
    fx.sqlite.close();
  });

  it("never accrues a pair involving a machine-authored or mirrored entry", async () => {
    const fx = makeInsightFixture();
    await runInsightAccrual(fx.env, ctx);

    const pairs = await fx.pairs();
    expect(involves(pairs, "decoy-machine")).toBe(false);
    expect(involves(pairs, "decoy-mirror")).toBe(false);
    fx.sqlite.close();
  });

  it("never accrues the near-duplicate written days rather than months apart", async () => {
    const fx = makeInsightFixture();
    await runInsightAccrual(fx.env, ctx);

    expect(involves(await fx.pairs(), "decoy-recent")).toBe(false);
    fx.sqlite.close();
  });

  it("ranks the successive metric snapshots below both planted pairs", async () => {
    // The state pair is admissible — similar, months apart — so this is a
    // ranking assertion, not a filtering one. It is the check that stops
    // "you had 1,462 clones in May and 733 in August" winning the week.
    //
    // Asserted as the full ordered list, not via findIndex: findIndex only
    // catches the FIRST planted pair it meets, so the other one sinking
    // below the state pair went undetected; an `if (found !== -1)` guard
    // silently no-ops when the state pair is absent; and `-1` (not found)
    // satisfies `toBeLessThan(0)` for whichever pair goes missing. None of
    // those failure modes exist against a single expected array.
    const fx = makeInsightFixture();
    await runInsightAccrual(fx.env, ctx);

    expect(await fx.pairs()).toEqual([
      "plant-connection-a|plant-connection-b",
      "plant-contradiction-new|plant-contradiction-old",
      "decoy-state-new|decoy-state-old",
    ]);
    fx.sqlite.close();
  });

  it("applies the state-volatility penalty to the successive metric snapshots' score", async () => {
    // This asserts the stored score against the formula computed by hand,
    // with the penalty as a literal 0.4 rather than imported from the
    // module under test — a mutation there has nothing to hide behind,
    // unlike an assertion built from src/insight/score.ts's own exports,
    // which would move with the mutation and never be able to catch it.
    // (Whether the ranking test above also happens to catch this same
    // mutation is verified separately, in task-9-report.md, rather than
    // asserted here from arithmetic alone.)
    const fx = makeInsightFixture();
    await runInsightAccrual(fx.env, ctx);

    const row = await rowFor(fx.sqlite, "decoy-state-old", "decoy-state-new");
    expect(row).not.toBeNull();
    const gapDays = row!.gap_ms / DAY;
    const importanceBoost = 1 + 0.1 * 3; // neither entry overrides the default importance (3)
    // Both carry "metrics" as their only topic tag (volatility:state is a
    // reserved tag, not a topic — src/insight/eligibility.ts's topicTagsOf
    // strips it), so this is the shared-topic case: crossTagBonus is 1.0.
    const crossTagBonus = 1.0;
    const statePenalty = 0.4;
    const expected = row!.similarity * Math.log1p(gapDays) * importanceBoost * crossTagBonus * statePenalty;
    expect(row!.score).toBeCloseTo(expected, 10);
    fx.sqlite.close();
  });

  it("applies the cross-topic bonus to the planted connection pair's score", async () => {
    // Same reasoning as the state-penalty test above: this pins the bonus
    // directly against a hand-computed expectation, built without importing
    // anything from src/insight/score.ts, so a mutation to the constant it
    // asserts on has nothing there to hide behind.
    const fx = makeInsightFixture();
    await runInsightAccrual(fx.env, ctx);

    const row = await rowFor(fx.sqlite, "plant-connection-a", "plant-connection-b");
    expect(row).not.toBeNull();
    const gapDays = row!.gap_ms / DAY;
    const importanceBoost = 1 + 0.1 * 4; // both entries set importance: 4
    // "onboarding" and "support" share no topic tag — the unlikely-connection
    // bonus applies: crossTagBonus is 1.25, not 1.0.
    const crossTagBonus = 1.25;
    const statePenalty = 1.0; // neither entry carries volatility:state
    const expected = row!.similarity * Math.log1p(gapDays) * importanceBoost * crossTagBonus * statePenalty;
    expect(row!.score).toBeCloseTo(expected, 10);
    fx.sqlite.close();
  });
});
