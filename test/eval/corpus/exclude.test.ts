import { describe, expect, it } from "vitest";
import { excludeNeedles, globToRegExp } from "./exclude";
import type { CorpusSpec } from "./types";
import { ACTORS, EVAL_NOW, WORKSPACES } from "./types";

const entry = (id: string) => ({ id, content: id, tags: [], source: "api", createdAt: EVAL_NOW, workspaceId: WORKSPACES.avery, actorId: ACTORS.avery });
const spec: CorpusSpec = {
  id: "t", intent: "tie",
  entries: [entry("n-a"), entry("n-lcoh-001"), entry("n-lcoh-002"), entry("f-1")],
  edges: [{ id: "e1", sourceId: "n-a", targetId: "n-lcoh-001", type: "caused_by", weight: 1, provenance: "explicit", workspaceId: WORKSPACES.avery }],
  queries: [
    { id: "q1", category: "paraphrase", text: "x", gold: [{ id: "n-a", grade: 2 }], viewer: "avery" },
    { id: "q2", category: "long-context", text: "y", gold: [{ id: "n-lcoh-001", grade: 2 }], viewer: "avery" },
    { id: "q3", category: "multi-hop", text: "z", gold: [{ id: "n-a", grade: 2 }, { id: "n-lcoh-002", grade: 1 }], viewer: "avery" },
  ],
};

describe("excludeNeedles", () => {
  it("matches a glob against the whole id", () => {
    expect(globToRegExp("n-lcoh-*").test("n-lcoh-042")).toBe(true);
    expect(globToRegExp("n-lcoh-*").test("xn-lcoh-042")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("drops the entries, their edges, and the queries whose answer was removed, keeping the rest", () => {
    const { spec: reduced, removedEntries, removedQueries } = excludeNeedles(spec, ["n-lcoh-*"]);
    expect(reduced.entries.map(e => e.id)).toEqual(["n-a", "f-1"]);
    expect(reduced.edges).toEqual([]);
    expect(reduced.queries.map(q => q.id)).toEqual(["q1", "q3"]);
    expect([removedEntries, removedQueries]).toEqual([2, 1]);
    expect(spec.entries).toHaveLength(4);
  });

  it("changes nothing for a pattern that matches nothing", () => {
    const { spec: same, removedEntries } = excludeNeedles(spec, ["zzz-*"]);
    expect(same.entries).toHaveLength(4);
    expect(removedEntries).toBe(0);
  });
});
