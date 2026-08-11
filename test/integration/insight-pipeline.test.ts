import { describe, it, expect, vi, beforeEach } from "vitest";
import { runInsightAccrual } from "../../src/insight/candidates";
import { resetDatabaseInit } from "../../src/db/init";
import { makeInsightFixture, FIXTURE_NOW } from "../helpers/insight-fixture";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const involves = (pairs: string[], id: string) => pairs.some(p => p.split("|").includes(id));

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

  it("ranks the successive metric snapshots below the planted insights", async () => {
    // The state pair is admissible — similar, months apart — so this is a
    // ranking assertion, not a filtering one. It is the check that stops
    // "you had 1,462 clones in May and 733 in August" winning the week.
    const fx = makeInsightFixture();
    await runInsightAccrual(fx.env, ctx);

    const pairs = await fx.pairs();               // ordered by score DESC
    const statePair = pairs.findIndex(p => p.includes("decoy-state"));
    const plantedPair = pairs.findIndex(p => p.includes("plant-"));
    if (statePair !== -1) expect(plantedPair).toBeLessThan(statePair);
    fx.sqlite.close();
  });
});
