import { describe, it, expect } from "vitest";
import { renderRecallText } from "../../src/recall/render";
import { computeCompoundStale } from "../../src/recall/compound-stale";
import type { RecallMatch } from "../../src/recall/types";

const AGED_MS = 91 * 86400000;

function match(partial: Partial<RecallMatch> & Pick<RecallMatch, "id">): RecallMatch {
  const agedAt = Date.now() - AGED_MS;
  return {
    content: partial.content ?? "content",
    score: partial.score ?? 0.8,
    createdAt: partial.createdAt ?? agedAt,
    updatedAt: partial.updatedAt ?? agedAt,
    tags: partial.tags ?? [],
    source: partial.source ?? "api",
    isUpdate: partial.isUpdate ?? false,
    hop: partial.hop ?? 0,
    staleAsOf: partial.staleAsOf ?? false,
    ...partial,
  };
}

describe("renderRecallText staleness", () => {
  it("includes as-of qualifier for stale entries", () => {
    const text = renderRecallText([
      match({ id: "a", staleAsOf: true, tags: ["stale:as-of"], updatedAt: new Date("2024-01-15").getTime() }),
    ], "");
    expect(text).toContain("verify before asserting");
    expect(text).toContain("true as of");
  });

  it("prefixes compound stale warning from stale-as-of matches after budget", () => {
    const text = renderRecallText([
      match({ id: "a", staleAsOf: true, tags: ["stale:as-of"] }),
      match({ id: "b", staleAsOf: true, tags: ["stale:as-of"], updatedAt: Date.now() - AGED_MS - 1000 }),
    ], "");
    expect(text).toContain("Staleness warning");
    expect(text).toContain("stale as-of");
  });
});

describe("computeCompoundStale", () => {
  it("returns signal when two or more stale-as-of matches are 90+ days old", () => {
    const aged = Date.now() - AGED_MS;
    const signal = computeCompoundStale([
      match({ id: "a", staleAsOf: true, updatedAt: aged }),
      match({ id: "b", staleAsOf: true, updatedAt: aged - 1000 }),
    ]);
    expect(signal).toEqual({ count: 2, oldestUpdatedAt: aged - 1000 });
  });

  it("returns undefined for aged matches without stale-as-of flag", () => {
    const aged = Date.now() - AGED_MS;
    expect(computeCompoundStale([
      match({ id: "a", updatedAt: aged }),
      match({ id: "b", updatedAt: aged - 1000 }),
    ])).toBeUndefined();
  });

  it("returns undefined for a single aged match", () => {
    expect(computeCompoundStale([match({ id: "a" })])).toBeUndefined();
  });

  it("ignores fresh matches", () => {
    expect(computeCompoundStale([
      match({ id: "a", updatedAt: Date.now() - 10 * 86400000 }),
      match({ id: "b", updatedAt: Date.now() - 20 * 86400000 }),
    ])).toBeUndefined();
  });
});
