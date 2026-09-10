/**
 * The home board: tiles rendered from the brief the Worker already returns.
 * Each tile hides itself when its data is missing or the endpoint refuses.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const src = ["public/js/i18n.js", "public/utils.js", "public/js/state.js", "public/js/api.js", "public/js/board.js", "public/js/chart.js"]
  .map((f) => readFileSync(resolve(ROOT, f), "utf8"))
  .join("\n");

function fakeDoc() {
  const made: any[] = [];
  const el = (tag = "div") => {
    const e: any = {
      tag,
      children: [] as any[],
      dataset: {},
      style: {},
      hidden: false,
      className: "",
      innerHTML: "",
      textContent: "",
      setAttribute() {},
      appendChild(c: any) {
        this.children.push(c);
        return c;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
    };
    made.push(e);
    return e;
  };
  const ids: Record<string, any> = { "board-tiles": el("section"), board: el() };
  return {
    made,
    ids,
    document: {
      getElementById: (id: string) => ids[id] ?? null,
      createElement: el,
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: { lang: "en" },
    },
  };
}

describe("board tiles", () => {
  it("renders memories and week tiles from the brief and hides tiles without data", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({
      ok: true,
      total: 1204,
      activity: Array.from({ length: 14 }, (_, i) => ({ day: i, count: i < 7 ? 0 : 5 })),
      sources: [],
      topics: [],
      patterns: [],
      attention: { unindexed: 0, stale: 0, patterns: 0 },
    });
    const tiles = ids["board-tiles"].children;
    expect(ids["board-tiles"].hidden).toBe(false);
    // connections hidden on 404, recalls and contradictions absent (Phase 3)
    expect(tiles.map((t: any) => t.dataset.tile)).toEqual(["memories"]);
    expect(tiles[0].innerHTML).toMatch(/1,204/);
    expect(tiles[0].innerHTML).toMatch(/35/); // last 7 days summed like home.js does
  });
});

describe("decisions panel", () => {
  it("renders up to two insights as stops on the thread, with a more-button past two", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({
      ok: true,
      total: 10,
      activity: [],
      sources: [],
      topics: [],
      patterns: [
        { id: "p1", content: "x".repeat(50) },
        { id: "p2", content: "y".repeat(50) },
        { id: "p3", content: "z".repeat(50) },
      ],
      attention: { unindexed: 0, stale: 0, patterns: 3 },
    });
    const decide = ids.board.children.find((c: any) => c.dataset.panel === "decide");
    expect(decide, "decide panel should render").toBeTruthy();
    const html = decide.body.innerHTML as string;
    expect((html.match(/data-insight/g) || []).length).toBe(2);
    expect(html).toMatch(/brief-more/);
  });

  it("appends nothing when there are no insights and nothing needs attention", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ids.board.children.find((c: any) => c.dataset.panel === "decide")).toBeUndefined();
  });
});

describe("growth panel", () => {
  it("renders from brief.activity when there is data, and hides otherwise", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({
      ok: true,
      total: 10,
      activity: Array.from({ length: 14 }, (_, i) => ({ day: i, count: i })),
      sources: [],
      topics: [],
      patterns: [],
      attention: { unindexed: 0, stale: 0, patterns: 0 },
    });
    expect(ids.board.children.find((c: any) => c.dataset.panel === "growth")).toBeTruthy();

    const { ids: ids2, document: document2 } = fakeDoc();
    const ctx2: any = { ...ctx, document: document2 };
    vm.createContext(ctx2);
    vm.runInContext(src, ctx2);
    await ctx2.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ids2.board.children.find((c: any) => c.dataset.panel === "growth")).toBeUndefined();
  });
});

describe("graph preview panel", () => {
  function nodesAndEdges(n: number) {
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, tags: [i % 2 ? "alpha" : "beta"], importance: i % 5 }));
    const edges = nodes.slice(1).map((n, i) => ({ source: nodes[i].id, target: n.id, weight: 1 }));
    return { nodes, edges };
  }

  it("hides when the graph has fewer than 5 nodes", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) => (url.includes("/graph") ? { ok: true, json: async () => ({ ok: true, ...nodesAndEdges(3) }) } : { ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ids.board.children.find((c: any) => c.dataset.panel === "graph")).toBeUndefined();
  });

  it("renders a panel when the graph has at least 5 nodes", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) => (url.includes("/graph") ? { ok: true, json: async () => ({ ok: true, ...nodesAndEdges(8) }) } : { ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ids.board.children.find((c: any) => c.dataset.panel === "graph")).toBeTruthy();
  });
});
