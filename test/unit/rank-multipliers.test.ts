/**
 * Task B6 (T-0089.2.3, spec 14 5.8): the mild stale penalty in current queries, eval-gated.
 * stale_penalty equals STALE_PENALTY when the query intent is "current" and the row carries
 * stale:as-of (not retracted-source), and 1 otherwise. Default STALE_PENALTY is 1.0 (off) per the
 * director's ku-silent guidance (2026-09-27); the real multiplier is 0.9.
 */
import { describe, it, expect } from "vitest";
import { rerankWithTimeDecayTraced } from "../../src/recall/math";
import { renderRecallText } from "../../src/recall/render";
import type { RecallMatch, WhyTrace } from "../../src/recall/types";
import type { RecallIntent } from "../../src/recall/query-profile";
import { DEFAULTS } from "../../src/config";
import { STALE_AS_OF } from "../../src/memory/stale";
import { RETRACTED_SOURCE_TAG } from "../../src/memory/validity";

const NOW = Date.now();
const DAY = 86400000;
const mk = (id: string, tags: string[] = []) => ({ id, score: 0.8, metadata: { parentId: id, created_at: NOW - 10 * DAY, tags } });
const args = (intent: RecallIntent) =>
  [new Map(), new Map(), [] as string[], new Map(), new Map(), new Map(), { ...DEFAULTS, STALE_PENALTY: 0.9 }, { intent }] as const;

describe("stale_penalty (5.8/B6)", () => {
  it("applies only to stale:as-of rows under current intent", () => {
    const staleUnderCurrent = rerankWithTimeDecayTraced([mk("a", [STALE_AS_OF])], ...args("current"))[0].multipliers;
    expect(staleUnderCurrent.stale_penalty).toBe(0.9);

    const staleUnderOtherIntent = rerankWithTimeDecayTraced([mk("b", [STALE_AS_OF])], ...args("direct"))[0].multipliers;
    expect(staleUnderOtherIntent.stale_penalty).toBe(1);

    const notStaleUnderCurrent = rerankWithTimeDecayTraced([mk("c", [])], ...args("current"))[0].multipliers;
    expect(notStaleUnderCurrent.stale_penalty).toBe(1);

    // retracted-source has its own warning; stale_penalty does not double up on it.
    const retractedSource = rerankWithTimeDecayTraced([mk("d", [STALE_AS_OF, RETRACTED_SOURCE_TAG])], ...args("current"))[0].multipliers;
    expect(retractedSource.stale_penalty).toBe(1);
  });

  it("STALE_PENALTY 1.0 changes nothing", () => {
    const [t] = rerankWithTimeDecayTraced(
      [mk("a", [STALE_AS_OF])],
      new Map(), new Map(), [], new Map(), new Map(), new Map(), DEFAULTS, { intent: "current" },
    );
    expect(t.multipliers.stale_penalty).toBe(1);
    expect(DEFAULTS.STALE_PENALTY).toBe(1.0);
  });

  it("factors the penalty into the reported score, not just the trace", () => {
    const penalized = rerankWithTimeDecayTraced([mk("a", [STALE_AS_OF])], ...args("current"))[0];
    const unpenalized = rerankWithTimeDecayTraced([mk("a", [])], ...args("current"))[0];
    expect(penalized.match.score).toBeLessThan(unpenalized.match.score);
  });

  it("explain reports it: stale_penalty rides in why.multipliers and whyText says possibly out of date", () => {
    const match: RecallMatch = {
      id: "a", content: "stale content", score: 0.8, createdAt: NOW - 100 * DAY, updatedAt: NOW - 100 * DAY,
      tags: [STALE_AS_OF], source: "api", isUpdate: false, hop: 0,
      validFrom: NOW - 100 * DAY, validFromStated: false, validUntil: null, validityState: "current",
      supersededBy: null, retractedSource: false,
    };
    const why: WhyTrace = {
      dense_rank: 1, keyword_terms: [], multipliers: {
        recency: 0.8, frequency: 1, combined: 0.8, importance: 1, tag_boost: 1,
        append_penalty: 1, rolled_up_penalty: 1, source_weight: 1, stale_penalty: 0.9,
      },
      rerank_percentile: null, rerank_move: null, age_known: true, graph: null, slot: "direct",
    };
    const text = renderRecallText([{ ...match, why }], "", { config: DEFAULTS });
    expect(text).toMatch(/possibly out of date/i);
  });
});
