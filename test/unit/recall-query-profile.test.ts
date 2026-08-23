import { describe, expect, it } from "vitest";
import {
  buildQueryProfile,
  edgeIntentCompatibility,
  embeddingInput,
} from "../../src/recall/query-profile";

describe("recall query profile", () => {
  it.each([
    ["why did the backend change", "causal"],
    ["what happened before the launch", "chronology"],
    ["what is the current archive direction", "current"],
    ["quartz archive architecture", "direct"],
  ] as const)("classifies %s", (query, intent) => {
    expect(buildQueryProfile(query, { query: "backend platform", df: null, total: null }).intent).toBe(intent);
  });

  it("keeps semantic and lexical representations separate", () => {
    const profile = buildQueryProfile(
      "why did we change the quartz ledger direction",
      { query: "quartz ledger", df: null, total: null },
    );
    expect(profile.semanticQuery).toBe("why did we change the quartz ledger direction");
    expect(profile.lexicalQuery).toBe("quartz ledger");
    expect(profile.evidenceTokens).toEqual(["change", "quartz", "ledger", "direction"]);
    expect(embeddingInput(profile, "distilled")).toBe("quartz ledger");
    expect(embeddingInput(profile, "semantic")).toBe(profile.semanticQuery);
    expect(embeddingInput(profile, "hybrid")).toBe(
      "why did we change the quartz ledger direction quartz ledger",
    );
  });

  it("bounds full cleaned-query evidence tokens deterministically", () => {
    const query = Array.from({ length: 20 }, (_, index) => `signal${index}`).join(" ");

    expect(buildQueryProfile(query, { query: "signal19 signal18 signal17", df: null, total: null }).evidenceTokens)
      .toEqual(Array.from({ length: 16 }, (_, index) => `signal${index}`));
  });

  it("keeps distilled terms first and adds rarer full-query anchors", () => {
    const df = new Map([
      ["quartz", 90], ["ledger", 4], ["support", 8], ["protocol", 12],
    ]);
    const profile = buildQueryProfile(
      "why did the quartz ledger change for support protocol",
      { query: "ledger", df, total: 100 },
    );

    expect(profile.retrievalTokens).toEqual(["ledger", "support", "protocol", "quartz", "change"]);
  });

  it("preserves identifier-shaped anchors within the existing token cap", () => {
    const query = "why issue #311 changed v2.3.2 "
      + Array.from({ length: 30 }, (_, index) => `signal${index}`).join(" ");
    const tokens = buildQueryProfile(query, { query: "changed", df: null, total: null }).retrievalTokens;

    expect(tokens).toEqual(expect.arrayContaining(["#311", "v2.3.2"]));
    expect(tokens).toHaveLength(16);
  });

  it("uses bounded deterministic variants without replacing original evidence", () => {
    const tokens = buildQueryProfile(
      "Did North Harbor teams review launch-plans on June 3?",
      { query: "review", df: null, total: null },
    ).retrievalTokens;

    expect(tokens.slice(0, 6)).toEqual(["review", "launch-plans", "north", "harbor", "teams", "june"]);
    expect(tokens).toEqual(expect.arrayContaining([
      "launchplans", "launch", "plans", "nh", "june 3", "team", "plan",
    ]));
    expect(tokens.length).toBeLessThanOrEqual(16);
  });

  it("never lets variants displace the capped original token set", () => {
    const query = Array.from({ length: 20 }, (_, index) => `records${index}`).join(" ");
    const tokens = buildQueryProfile(query, { query: "records19", df: null, total: null }).retrievalTokens;

    expect(tokens).toHaveLength(16);
    expect(tokens[0]).toBe("records19");
    expect(tokens).not.toContain("record19");
  });

  it("uses edge types as soft intent compatibility", () => {
    expect(edgeIntentCompatibility("causal", "caused_by")).toBeGreaterThan(
      edgeIntentCompatibility("causal", "relates_to"),
    );
    expect(edgeIntentCompatibility("chronology", "follows")).toBeGreaterThan(
      edgeIntentCompatibility("chronology", "relates_to"),
    );
    expect(edgeIntentCompatibility("direct", "decided")).toBe(0.5);
  });
});
