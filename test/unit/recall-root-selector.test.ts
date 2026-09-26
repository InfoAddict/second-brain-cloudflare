import { describe, expect, it } from "vitest";
import { selectGraphRoots, type RootCandidate } from "../../src/recall/root-selector";

function candidate(
  parentId: string,
  rootScore: number,
  lexicalCoverage: number,
  metadataAlignment: number,
): RootCandidate {
  return {
    id: parentId,
    score: rootScore,
    parentId,
    rootScore,
    localEvidence: parentId,
    tags: [],
    lexicalCoverage,
    metadataAlignment,
    values: [rootScore, lexicalCoverage, metadataAlignment],
  };
}

describe("selectGraphRoots", () => {
  it("preserves a rare lexical root outside the semantic leaders", () => {
    const candidates = [
      ...Array.from({ length: 8 }, (_, i) => candidate(`semantic-${i}`, 1 - i * 0.02, 0.05, 0)),
      candidate("rare-root", 0.55, 1, 0),
    ];

    const selected = selectGraphRoots(candidates, 6, 0.7);

    expect(selected.map(x => x.candidate.parentId)).toContain("rare-root");
    expect(selected.find(x => x.candidate.parentId === "rare-root")?.selectedBy).toBe("lexical");
  });

  it("keeps root IDs unique and respects the existing cap", () => {
    const fixtures = [
      candidate("a", 1, 0.4, 0.2),
      candidate("a", 0.9, 0.5, 0.1),
      candidate("b", 0.8, 0.3, 0.9),
      candidate("c", 0.7, 0.8, 0.4),
    ];

    const selected = selectGraphRoots(fixtures, 15, 0.7);

    expect(new Set(selected.map(x => x.candidate.parentId)).size).toBe(selected.length);
    expect(selected.length).toBeLessThanOrEqual(15);
  });

  it("uses stable parent IDs to break exact ties", () => {
    const ids = selectGraphRoots([candidate("b", 1, 1, 1), candidate("a", 1, 1, 1)], 2, 0.7)
      .map(x => x.candidate.parentId);

    expect(ids).toEqual(["a", "b"]);
  });

  it("reserves a position for every view when the budget permits", () => {
    const selected = selectGraphRoots([
      candidate("semantic", 1, 0.1, 0.1),
      candidate("lexical", 0.5, 1, 0.1),
      candidate("metadata", 0.4, 0.1, 1),
      candidate("diverse", 0.3, 0.1, 0.1),
    ], 4, 0.7);

    expect(selected.map(x => x.selectedBy).sort()).toEqual(["diversity", "lexical", "metadata", "semantic"]);
  });

  it("uses largest-remainder quotas after reserving every view", () => {
    const selected = selectGraphRoots([
      candidate("semantic-1", 1, 0.1, 0.1),
      candidate("semantic-2", 0.9, 0.2, 0.2),
      candidate("lexical-1", 0.5, 1, 0.1),
      candidate("lexical-2", 0.4, 0.9, 0.1),
      candidate("metadata", 0.3, 0.1, 1),
      candidate("diverse", 0.2, 0.1, 0.1),
    ], 6, 0.7);

    expect(selected.filter(x => x.selectedBy === "semantic")).toHaveLength(2);
    expect(selected.filter(x => x.selectedBy === "lexical")).toHaveLength(2);
    expect(selected.filter(x => x.selectedBy === "metadata")).toHaveLength(1);
    expect(selected.filter(x => x.selectedBy === "diversity")).toHaveLength(1);
  });
});

describe("evidenceScoreOf", () => {
  it("reads the pre-blend score when a reranker blended the root, else the root score", async () => {
    const { evidenceScoreOf } = await import("../../src/recall/root-selector");
    expect(evidenceScoreOf({ rootScore: 2, evidenceScore: 0.8 })).toBe(0.8);
    expect(evidenceScoreOf({ rootScore: 2 })).toBe(2);
  });

  it("every evidence consumer in search.ts goes through it: the omitted-root candidate, the normalizer and the linked parent score", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/recall/search.ts", import.meta.url).pathname, "utf8");
    expect(src.match(/evidenceScoreOf\(/g)?.length).toBe(3);
    // the only direct read of a root's blended score left is the displayed match score of an omitted root
    expect(src.match(/score: root\.rootScore/g)?.length).toBe(1);
    expect(src).toMatch(/score: evidenceScoreOf\(root\),[^\n]*\n\s+source: "omitted-root"/);
  });
});
