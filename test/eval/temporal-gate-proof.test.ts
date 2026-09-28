// T-0089.2.6 (14-t2-time-spec.md 6.5): every row runs the REAL evaluateGate on the RECORDED pre-Track-2 baseline
// and a transformed candidate -- never an invented ranking. The base data (rankedIds, pool composition, cost) is
// exactly what was recorded; only order (and occasionally membership) changes per hypothesis. This is the proof
// that the gate design itself, not a hand-built fixture, tells a right implementation from a known shortcut.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSyntheticCorpus } from "./corpus/synthetic";
import { KU_SILENT_TARGET } from "./corpus/synthetic-temporal";
import { evaluateGate } from "./gate";
import {
  asOfCreatedAtOnly, asOfCreatedAtRespectsValidUntil, beliefTimeAsOf, currentOracle, currentOracleNoRestore,
  demoteCorrectionLookingBack, demoteNewest, dropOwnTimeline, keepOnlyNewest, onlyCategory, oracleBeliefFirst,
  oracleBeliefsUnderTarget, oracleWithoutBeliefs, planOracle, recencySort, currentValidityEverywhere, boostWas,
  staleDemote, type Transform,
} from "./temporal-transforms";
import type { VariantReport } from "./types";

const baseline: VariantReport = JSON.parse(readFileSync(resolve(import.meta.dirname, "data/recorded/temporal.bge-small-en-v1.5.json"), "utf8"));
const corpus = buildSyntheticCorpus("temporal");
const BOOTSTRAP = { iterations: 10_000 } as const; // 14-t2-time-spec.md 6.5's production default.

function candidate(name: string, transform: Transform): VariantReport {
  return { ...transform(baseline, corpus), variant: name };
}
// Every row compares straight against the RECORDED BASELINE: the comparison C6 will actually run (T-0089.2.6
// adversary round). Rows 9, 12 and KU-2 previously compared against the plan oracle instead, since retracted-past
// and corrected-backdated scored near the floor in the pre-fix baseline (nothing left to lose); re-recording the
// baseline with retracted rows deprecated, as production already treats them, gave those subsets real headroom
// (1.000/1.000/1.000, or 0.500 MRR for retracted-past) so the baseline itself now carries the proof, with
// CorpusSpec.floors as the mechanical backstop the delta-based rules alone cannot express.
const duringGate = (cand: VariantReport, base: VariantReport = baseline) => evaluateGate(base, cand, { targetCategories: ["temporal-during"], bootstrap: BOOTSTRAP, allowUnmeasuredRowsRead: true, floors: corpus.floors });
const kuGate = (cand: VariantReport, base: VariantReport = baseline) => evaluateGate(base, cand, { targetCategories: ["knowledge-update"], bootstrap: BOOTSTRAP, allowUnmeasuredRowsRead: true, floors: corpus.floors });
const rule = (r: ReturnType<typeof evaluateGate>, name: string) => r.rules.find(x => x.rule === name);

describe("temporal-during: a plan-following implementation passes", () => {
  it("row 1: the plan oracle (valid documents, beliefs demoted below) PASSES on improvement", () => {
    const result = duringGate(candidate("plan-oracle", onlyCategory("temporal-during", planOracle)));
    expect(result.verdict).toBe("PASS");
    expect(rule(result, "improvement")?.status).toBe("pass");
    expect(rule(result, "subset-regression")?.status).toBe("pass");
  });

  it("row 2: the oracle without beliefs at all also PASSES", () => {
    const result = duringGate(candidate("oracle-no-beliefs", onlyCategory("temporal-during", oracleWithoutBeliefs)));
    expect(result.verdict).toBe("PASS");
    expect(rule(result, "improvement")?.status).toBe("pass");
  });

  it("row 3: beliefs attached under their target (not dropped, not at the bottom) also PASSES", () => {
    const result = duringGate(candidate("oracle-beliefs-under-target", onlyCategory("temporal-during", oracleBeliefsUnderTarget)));
    expect(result.verdict).toBe("PASS");
    expect(rule(result, "improvement")?.status).toBe("pass");
  });
});

describe("temporal-during: every known shortcut fails, and names why", () => {
  it("row 4: identity (the recorded baseline itself) FAILs on no improvement", () => {
    const result = duringGate(candidate("identity", (report) => report));
    expect(result.verdict).not.toBe("PASS");
    expect(rule(result, "improvement")?.status).not.toBe("pass");
  });

  it("row 5: demoting the newest document regresses during-after-change, backdated-newest, corrected-backdated, recap-gold (their gold IS the newest)", () => {
    const result = duringGate(candidate("demote-newest", onlyCategory("temporal-during", demoteNewest)));
    expect(result.verdict).toBe("FAIL");
    expect(rule(result, "subset-regression")?.status).toBe("fail");
    for (const subset of ["during-after-change", "backdated-newest", "corrected-backdated", "recap-gold"]) {
      expect(result.subsetRegressions.some(s => s.includes(`[subset:${subset}]`)), `expected a regression naming subset:${subset} in: ${result.subsetRegressions.join("; ")}`).toBe(true);
    }
  });

  it("row 6: demoting 'Correction'/'Looking back' documents regresses recap-gold (its gold uses those exact words)", () => {
    const result = duringGate(candidate("demote-correction-lookingback", onlyCategory("temporal-during", demoteCorrectionLookingBack)));
    expect(result.verdict).toBe("FAIL");
    // corrected-backdated's own retrieved pool is dominated by retro's "Looking back" recap phrasing too (shared
    // billing-address wording), so the shortcut flags everything near the top of that query and demotes nothing
    // relative to it; recap-gold alone still regresses and carries the row.
    expect(result.subsetRegressions.some(s => s.includes("[subset:recap-gold]"))).toBe(true);
  });

  it("row 7: boosting documents containing ' was ' regresses backdated-past and during-after-change (their gold has no 'was', a sibling does)", () => {
    const result = duringGate(candidate("boost-was", onlyCategory("temporal-during", boostWas)));
    expect(result.verdict).toBe("FAIL");
    for (const subset of ["backdated-past", "during-after-change"]) {
      expect(result.subsetRegressions.some(s => s.includes(`[subset:${subset}]`))).toBe(true);
    }
  });

  it("row 9: promoting the retracted belief to rank 1 regresses retracted-past and corrected-backdated from the RECORDED BASELINE directly, via the forbidden cut", () => {
    const result = duringGate(candidate("belief-first", onlyCategory("temporal-during", oracleBeliefFirst)));
    expect(result.verdict).toBe("FAIL");
    for (const subset of ["retracted-past", "corrected-backdated"]) {
      expect(result.subsetRegressions.some(s => s.includes(`[subset:${subset}]`))).toBe(true);
    }
  });

  it("row 10: as-of on created_at only (no upper bound) regresses every backdated/newest-gold subset by dropping the late-told gold entirely", () => {
    const result = duringGate(candidate("asof-created-at-only", onlyCategory("temporal-during", asOfCreatedAtOnly)));
    expect(result.verdict).toBe("FAIL");
    for (const subset of ["backdated-past", "backdated-newest", "corrected-backdated", "recap-gold"]) {
      expect(result.subsetRegressions.some(s => s.includes(`[subset:${subset}]`)), `expected a regression naming subset:${subset} in: ${result.subsetRegressions.join("; ")}`).toBe(true);
    }
  });

  it("row 11: as-of on created_at respecting validUntil but ignoring a backdated validFrom fails the same way as row 10", () => {
    const result = duringGate(candidate("asof-created-at-respects-validuntil", onlyCategory("temporal-during", asOfCreatedAtRespectsValidUntil)));
    expect(result.verdict).toBe("FAIL");
  });

  it("row 12: belief-time as-of (show what was believed, not what was true) regresses retracted-past and corrected-backdated from the RECORDED BASELINE directly", () => {
    const result = duringGate(candidate("belief-time-asof", onlyCategory("temporal-during", beliefTimeAsOf)));
    expect(result.verdict).toBe("FAIL");
    for (const subset of ["retracted-past", "corrected-backdated"]) {
      expect(result.subsetRegressions.some(s => s.includes(`[subset:${subset}]`))).toBe(true);
    }
  });

  it("row 13: keeping only the newest document regresses several subsets", () => {
    const result = duringGate(candidate("keep-only-newest", onlyCategory("temporal-during", keepOnlyNewest)));
    expect(result.verdict).toBe("FAIL");
    expect(rule(result, "subset-regression")?.status).toBe("fail");
  });

  it("row 14: dropping a query's whole timeline regresses every subset (nothing left to rank)", () => {
    const result = duringGate(candidate("drop-own-timeline", onlyCategory("temporal-during", dropOwnTimeline)));
    expect(result.verdict).toBe("FAIL");
    expect(result.subsetRegressions.length).toBeGreaterThan(3);
  });

  it("row 15: current validity applied to an as-of question regresses during-before-change (old is superseded by now, but was the right answer in April)", () => {
    const result = duringGate(candidate("current-validity-everywhere", onlyCategory("temporal-during", currentValidityEverywhere)));
    expect(result.verdict).toBe("FAIL");
    expect(result.subsetRegressions.some(s => s.includes("[subset:during-before-change]"))).toBe(true);
  });

  it("row 16: a plain recency sort regresses several subsets, the shortcut a recency boost takes", () => {
    const result = duringGate(candidate("recency-sort", onlyCategory("temporal-during", recencySort)));
    expect(result.verdict).toBe("FAIL");
    expect(rule(result, "subset-regression")?.status).toBe("fail");
  });
});

describe("knowledge-update: D-RET's restore is what a right implementation needs", () => {
  it("KU-1: the current oracle (drop rows closed at now, deprecated rows) PASSES", () => {
    const result = kuGate(candidate("ku-current-oracle", onlyCategory("knowledge-update", currentOracle)));
    expect(result.verdict).toBe("PASS");
    expect(rule(result, "improvement")?.status).toBe("pass");
  });

  it("KU-2: the current oracle without D-RET's restore FAILs on the retracted current questions, from the RECORDED BASELINE directly (old stays hidden after bad is itself retracted)", () => {
    const result = kuGate(candidate("ku-no-restore", onlyCategory("knowledge-update", currentOracleNoRestore)));
    expect(result.verdict).toBe("FAIL");
    expect(rule(result, "subset-regression")?.status).toBe("fail");
    // ku-retracted split out of "current" (T-0089.2.6 adversary round): it is the retracted current question this
    // row exists to catch, and where "old" stays wrongly hidden after "bad" itself is retracted.
    expect(result.subsetRegressions.some(s => s.includes("[subset:ku-retracted]"))).toBe(true);
  });

  it("KU-3: demoting the newest document regresses knowledge-update broadly (every gold there is the newest, by construction)", () => {
    const result = kuGate(candidate("ku-demote-newest", onlyCategory("knowledge-update", demoteNewest)));
    expect(result.verdict).toBe("FAIL");
    expect(rule(result, "regression")?.status).toBe("fail");
  });

  it("KU-4: T-0089.2.3's stale-penalty upper bound PASSes ku-silent through --target-subsets, the category margin alone cannot see it", () => {
    const result = evaluateGate(baseline, candidate("ku-stale-demote", onlyCategory("knowledge-update", staleDemote)), {
      targetCategories: ["knowledge-update"], targetSubsets: [KU_SILENT_TARGET], bootstrap: BOOTSTRAP, allowUnmeasuredRowsRead: true, floors: corpus.floors,
    });
    expect(result.verdict).toBe("PASS");
    expect(rule(result, "improvement")?.status).toBe("pass");
    expect(rule(result, "improvement")?.detail).toContain(KU_SILENT_TARGET);
  });
});

describe("the transforms never read anything but the report and the spec", () => {
  it("is deterministic: the same transform on the same recorded report gives byte-identical output", () => {
    const a = candidate("plan-oracle", onlyCategory("temporal-during", planOracle));
    const b = candidate("plan-oracle", onlyCategory("temporal-during", planOracle));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("touches no global state: applying a transform does not mutate the recorded baseline object", () => {
    const before = JSON.stringify(baseline);
    candidate("plan-oracle", onlyCategory("temporal-during", planOracle));
    expect(JSON.stringify(baseline)).toBe(before);
  });
});
