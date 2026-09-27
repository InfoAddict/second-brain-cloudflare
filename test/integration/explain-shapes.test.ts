/**
 * T-0089.5.1 (QA): explain off is byte-identical, and explain on changes nothing but the why data,
 * across the query shapes the small fixture in explain-recall.test.ts does not reach: the graph slot,
 * keyword-only and semantic-down recall, empty results, truncated snippets and the compound-stale note.
 *
 * The golden was captured by running these same shapes against release/v4 (before the feature).
 */
import { describe, it, expect } from "vitest";
import golden from "../fixtures/explain-shapes-off-golden.json";
import { SHAPES, runShape } from "../helpers/explain-shapes";

const names = Object.keys(SHAPES);
const stripWhy = (body: any) => body.results ? { ...body, results: body.results.map(({ why: _w, ...r }: any) => r) } : body;

describe.each(names)("explain shape: %s", (name) => {
  const want = (golden as any)[name];

  it("off: REST JSON and MCP text are byte-identical to release/v4", async () => {
    const off = await runShape(name, false);
    expect(JSON.stringify(off.rest)).toBe(JSON.stringify(want.rest));
    expect(off.mcp).toBe(want.mcp);
  });

  it("on: same results, order and text; one why line per MCP result; a why object per REST result", async () => {
    const on = await runShape(name, true);
    expect(JSON.stringify(stripWhy(on.rest))).toBe(JSON.stringify(want.rest));
    const results = on.rest.results ?? [];
    for (const r of results) expect(Object.keys(r.why).sort()).toEqual(["age_known", "dense_rank", "graph", "keyword_terms", "multipliers", "rerank_move", "rerank_percentile", "slot"]);
    const lines = on.mcp.split("\n");
    const ids = lines.filter(l => l.startsWith("ID: ")).length;
    expect(lines.filter(l => l.startsWith("why: ")).length).toBe(ids);
    expect(ids).toBe(results.length);
    for (const [i, l] of lines.entries()) if (l.startsWith("ID: ")) expect(lines[i + 1]).toMatch(/^why: /);
    expect(lines.filter(l => !l.startsWith("why: ")).join("\n")).toBe(want.mcp);
    expect(on.mcp).not.toContain("—");
  });
});

describe("explain costs nothing on any shape", () => {
  it.each(names)("%s: same D1 statements, model calls and Vectorize queries with explain on", async (name) => {
    const off = await runShape(name, false);
    const on = await runShape(name, true);
    expect(on.cost).toEqual(off.cost);
    expect(off.cost[0]).toBeGreaterThan(0);
  });
});

describe("explain shape coverage is real", () => {
  it("graph shapes actually seat a linked or evidence result", async () => {
    for (const name of ["graphSlot", "linkedFew"]) {
      const on = await runShape(name, true);
      const slots = on.rest.results.map((r: any) => r.why.slot);
      expect(slots.some((s: string) => s === "evidence" || s === "linked"), `${name}: ${slots}`).toBe(true);
      const linked = on.rest.results.filter((r: any) => r.hop > 0);
      for (const r of linked) {
        expect(r.why.graph).toEqual({ provenance: "explicit", type: "relates_to", from: expect.any(String) });
        expect(r.why.multipliers === null || typeof r.why.multipliers.recency === "number").toBe(true);
      }
      if (linked.length) expect(on.mcp).toMatch(/why: .*linked from/);
    }
  });

  it("keyword-only shapes report a null dense rank and matched terms", async () => {
    for (const name of ["keywordOnly", "semanticDown"]) {
      const on = await runShape(name, true);
      expect(on.rest.results.length).toBeGreaterThan(0);
      for (const r of on.rest.results) {
        expect(r.why.dense_rank).toBeNull();
        expect(r.why.keyword_terms.length).toBeGreaterThan(0);
      }
    }
  });

  it("the empty, truncated and compound-stale shapes exercise their branches", async () => {
    expect((await runShape("empty", false)).rest.results).toEqual([]);
    expect((await runShape("truncated", false)).mcp).toMatch(/truncated/);
    expect((await runShape("compoundStale", false)).mcp).toMatch(/stale|as of|older/i);
  });
});
