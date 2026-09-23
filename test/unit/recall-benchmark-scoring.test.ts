import { describe, expect, it } from "vitest";
import { KEYWORD_CANDIDATE_LIMIT, KEYWORD_MAX_TOKENS } from "../../src/constants";
import { baselineRecall, frozenPrePlanFused } from "../helpers/recall-benchmark-scoring";
import type { RootQualityCase } from "../fixtures/recall-root-quality";

const probe: RootQualityCase = {
  split: "development", domain: "personal", failureShape: "crowded-lexical-root", query: "quasar nebula", intent: "direct",
  candidates: [
    { id: "labeled", content: "quasar nebula orbit", keywordCandidate: true, createdAt: 1 },
    { id: "authority", content: "the Nebula catalog is authoritative", createdAt: 2 }, // shares vocabulary, never labeled
    { id: "unrelated", content: "gardening tips", createdAt: 3 },
  ],
  edges: [], authoritativeIds: ["authority"], acceptableRootIds: ["labeled"], candidateAvailable: true,
};

describe("frozenPrePlanFused keyword pool", () => {
  it("defaults to the labeled pool, byte-compatible with the mock benchmarks", () => {
    expect(frozenPrePlanFused(probe, ["quasar", "nebula"]).map(m => m.id)).toEqual(["labeled"]);
    expect(frozenPrePlanFused(probe, ["quasar", "nebula"], "labels")).toEqual(frozenPrePlanFused(probe, ["quasar", "nebula"]));
  });

  it("'like' builds the pool a real LIKE would: every row sharing a token (any case), none of the rest", () => {
    const ids = frozenPrePlanFused(probe, ["quasar", "nebula"], "like").map(m => m.id);
    expect(new Set(ids)).toEqual(new Set(["labeled", "authority"]));
  });

  it("'like' keeps the newest KEYWORD_CANDIDATE_LIMIT matches, as ORDER BY created_at DESC LIMIT does", () => {
    const rows = Array.from({ length: KEYWORD_CANDIDATE_LIMIT + 5 }, (_, i) => ({ id: `r${i}`, content: "shared token", createdAt: i + 1 }));
    const big: RootQualityCase = { ...probe, candidates: rows };
    const ids = frozenPrePlanFused(big, ["shared"], "like").map(m => m.id);
    expect(ids).toHaveLength(KEYWORD_CANDIDATE_LIMIT);
    expect(ids).not.toContain("r0");
    expect(ids).toContain(`r${KEYWORD_CANDIDATE_LIMIT + 4}`);
  });

  it("'like' only searches the first KEYWORD_MAX_TOKENS tokens, as keywordSearchLike does", () => {
    const tokens = Array.from({ length: KEYWORD_MAX_TOKENS }, (_, i) => `filler${i}`).concat("tail");
    const c: RootQualityCase = { ...probe, candidates: [{ id: "tail-only", content: "tail", createdAt: 1 }] };
    expect(frozenPrePlanFused(c, tokens, "like")).toEqual([]);
  });

  it("baselineRecall threads the pool through", () => {
    const withLabels = baselineRecall(probe, ["quasar", "nebula"], 5).directIds;
    const withLike = baselineRecall(probe, ["quasar", "nebula"], 5, "like").directIds;
    expect(withLabels).not.toContain("authority");
    expect(withLike).toContain("authority");
  });

  it("'like' reranks with recall counts of unlabeled pool rows, as a real DB would", () => {
    const twin = (recallCount: number): RootQualityCase => ({
      ...probe,
      candidates: [
        { id: "a", content: "quasar nebula alpha", createdAt: 5 },
        { id: "b", content: "quasar nebula alpha", createdAt: 5, recallCount },
      ],
    });
    const flat = baselineRecall(twin(0), ["quasar", "nebula"], 5, "like").directIds;
    const popular = baselineRecall(twin(500), ["quasar", "nebula"], 5, "like").directIds;
    expect(flat[0]).toBe("a");
    expect(popular[0]).toBe("b");
  });
});
