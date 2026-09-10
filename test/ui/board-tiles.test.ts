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
    // connections and recalls hidden: their endpoints 404 in this fixture; contradictions has no endpoint at all
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

describe("decisions thread refit", () => {
  // fakeDoc()'s el() has a stub querySelector (always null), fine for
  // asserting panel presence, but refitThread needs a DOM that actually
  // traverses appended children, the same shape chart.test.ts's harness uses.
  function makeNode(tag = "div") {
    const node: any = {
      tag,
      className: "",
      offsetTop: 0,
      style: {} as Record<string, string>,
      children: [] as any[],
      classList: { add() {}, remove() {}, contains: () => false },
      appendChild(c: any) {
        node.children.push(c);
        return c;
      },
      querySelector(sel: string): any {
        return queryOne(node, sel);
      },
      querySelectorAll(sel: string): any[] {
        const out: any[] = [];
        collectAll(node, sel, out);
        return out;
      },
    };
    return node;
  }
  function matches(node: any, sel: string): boolean {
    return sel.startsWith(".") ? (node.className || "").split(/\s+/).includes(sel.slice(1)) : false;
  }
  function queryOne(root: any, sel: string): any {
    for (const c of root.children) {
      if (matches(c, sel)) return c;
      const found = queryOne(c, sel);
      if (found) return found;
    }
    return null;
  }
  function collectAll(root: any, sel: string, out: any[]) {
    for (const c of root.children) {
      if (matches(c, sel)) out.push(c);
      collectAll(c, sel, out);
    }
  }

  it("spans exactly the first dot to the last stop's dot, and updates when a stop settles and shrinks the layout", () => {
    const ctx: any = { console };
    vm.createContext(ctx);
    vm.runInContext(readFileSync(resolve(ROOT, "public/js/board.js"), "utf8"), ctx);

    const body = makeNode();
    const thread = makeNode();
    thread.className = "thread";
    body.appendChild(thread);
    const stop1 = makeNode();
    stop1.className = "stop";
    stop1.offsetTop = 0;
    const stop2 = makeNode();
    stop2.className = "stop";
    stop2.offsetTop = 100;
    const stop3 = makeNode();
    stop3.className = "stop";
    stop3.offsetTop = 200;
    body.appendChild(stop1);
    body.appendChild(stop2);
    body.appendChild(stop3);

    ctx.refitThread(body);
    expect(thread.style.top).toBe(`${stop1.offsetTop + 9}px`);
    expect(thread.style.height).toBe(`${stop3.offsetTop + 25 - (stop1.offsetTop + 9)}px`);

    // Confirm/Dismiss settling a stop hides its body and actions, shrinking
    // it, modeled here as the last stop moving up, the real effect of the
    // stop above it (or itself) getting shorter. A thread still sized for
    // the old, taller layout would run past this new last dot.
    stop3.offsetTop = 120;
    ctx.refitThread(body);
    expect(thread.style.top).toBe(`${stop1.offsetTop + 9}px`);
    expect(thread.style.height).toBe(`${stop3.offsetTop + 25 - (stop1.offsetTop + 9)}px`);
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

  it("against an older Worker (no /stats/activity), shows the 14-day fallback with no range control or table toggle, and a note instead", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      // /stats/activity 404s; only /brief's 14-day activity is available.
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
    const growth = ids.board.children.find((c: any) => c.dataset.panel === "growth");
    expect(growth, "growth panel should still render from the 14-day fallback").toBeTruthy();
    expect(growth.head.children.find((c: any) => c.className === "seg"), "no range control against an older Worker").toBeUndefined();
    expect(growth.body.children.some((c: any) => c.className && c.className.includes("btn-secondary")), "no table toggle either").toBe(false);
    const note = growth.body.children.find((c: any) => c.className === "chart-note");
    expect(note, "a note explains why both controls are absent").toBeTruthy();
    expect(note.textContent.length).toBeGreaterThan(0);
  });

  it("attaches the panel to the board before measuring the chart container", async () => {
    // renderActivityChart reads chartEl.clientWidth/clientHeight to size the
    // SVG viewBox. A detached element (or one whose ancestor chain is not in
    // the document yet) reports both as 0, which silently falls back to a
    // hardcoded box that then letterboxes inside the real container, this
    // regressed once already by drawing the chart before appending the panel.
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
    let attachedWhenDrawn: boolean | null = null;
    ctx.renderActivityChart = () => {
      attachedWhenDrawn = ids.board.children.some((c: any) => c.dataset && c.dataset.panel === "growth");
    };
    await ctx.renderBoard({
      ok: true,
      total: 10,
      activity: Array.from({ length: 14 }, (_, i) => ({ day: i, count: i })),
      sources: [],
      topics: [],
      patterns: [],
      attention: { unindexed: 0, stale: 0, patterns: 0 },
    });
    expect(attachedWhenDrawn).toBe(true);
  });

  it("upgrades to /stats/activity by source, with a live enabled range control", async () => {
    const { ids, document } = fakeDoc();
    const days = 90;
    const start = 19000;
    const series = [
      { source: "claude-code", counts: Array.from({ length: days }, () => 3) },
      { source: "obsidian", counts: Array.from({ length: days }, () => 2) },
      { source: "chatgpt", counts: Array.from({ length: days }, () => 1) },
      { source: "email", counts: Array.from({ length: days }, () => 1) },
      { source: "notion", counts: Array.from({ length: days }, () => 1) },
    ];
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) =>
        url.includes("/stats/activity")
          ? { ok: true, json: async () => ({ ok: true, days, start, series }) }
          : { ok: false, status: 404, json: async () => ({}) },
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    const growth = ids.board.children.find((c: any) => c.dataset.panel === "growth");
    expect(growth, "growth panel should render from /stats/activity").toBeTruthy();
    const rangeButtons = growth.head.children.find((c: any) => c.className === "seg").children;
    expect(rangeButtons.every((b: any) => b.disabled === false)).toBe(true);
    expect(rangeButtons.find((b: any) => b.dataset.range === "90").tabIndex).toBe(0);
    expect(rangeButtons.find((b: any) => b.dataset.range === "30").tabIndex).toBe(-1);
  });
});

describe("recalled panel", () => {
  function fetchFor(entries: any[], total: number) {
    return async (url: string) =>
      url.includes("/stats/recalled")
        ? { ok: true, json: async () => ({ ok: true, total_recalls: total, entries }) }
        : { ok: false, status: 404, json: async () => ({}) };
  }

  it("renders rows from /stats/recalled and fills the recalls tile from total_recalls", async () => {
    const { ids, document } = fakeDoc();
    const entries = [
      { id: "a", content: "x".repeat(40), source: "claude-code", created_at: Date.now(), recall_count: 23 },
      { id: "b", content: "y".repeat(40), source: "obsidian", created_at: Date.now(), recall_count: 12 },
    ];
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: fetchFor(entries, 2318),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    const panel = ids.board.children.find((c: any) => c.dataset.panel === "recalled");
    expect(panel, "recalled panel should render").toBeTruthy();
    expect((panel.body.innerHTML.match(/class="row"/g) || []).length).toBe(2);
    const recallsTile = ids["board-tiles"].children.find((t: any) => t.dataset.tile === "recalls");
    expect(recallsTile, "recalls tile should fill from total_recalls").toBeTruthy();
    expect(recallsTile.innerHTML).toMatch(/2,318/);
    // No total_contradictions in this fixture (an older Worker's shape): the
    // fourth tile stays out rather than showing a false zero.
    expect(ids["board-tiles"].children.map((t: any) => t.dataset.tile)).toEqual(["memories", "recalls"]);
  });

  it("adds a fourth contradictions tile from the same /stats/recalled response when total_contradictions is present", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) =>
        url.includes("/stats/recalled")
          ? { ok: true, json: async () => ({ ok: true, total_recalls: 2318, total_contradictions: 12, entries: [] }) }
          : { ok: false, status: 404, json: async () => ({}) },
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ids["board-tiles"].children.map((t: any) => t.dataset.tile)).toEqual(["memories", "recalls", "contradictions"]);
    const tile = ids["board-tiles"].children.find((t: any) => t.dataset.tile === "contradictions");
    expect(tile.innerHTML).toMatch(/12/);
  });

  it("hides the panel and omits the tile when the endpoint has no entries", async () => {
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
    expect(ids.board.children.find((c: any) => c.dataset.panel === "recalled")).toBeUndefined();
    expect(ids["board-tiles"].children.find((t: any) => t.dataset.tile === "recalls")).toBeUndefined();
  });
});

describe("night panel", () => {
  function fetchFor(payload: any) {
    return async (url: string) => (url.includes("/stats/night") ? { ok: true, json: async () => payload } : { ok: false, status: 404, json: async () => ({}) });
  }
  const brief = { ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } };

  it("renders four rows when insights were proposed", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: fetchFor({ ok: true, ranAt: Date.now(), linksInferred: 41, insightsProposed: 2, digestsWritten: 1, claimsFlagged: 3 }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard(brief);
    const panel = ids.board.children.find((c: any) => c.dataset.panel === "night");
    expect(panel, "night panel should render").toBeTruthy();
    expect((panel.body.innerHTML.match(/night-row/g) || []).length).toBe(4);
  });

  it("hides the insights row at zero and hides the whole panel when ranAt is null", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: fetchFor({ ok: true, ranAt: Date.now(), linksInferred: 5, insightsProposed: 0, digestsWritten: 0, claimsFlagged: 0 }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard(brief);
    const panel = ids.board.children.find((c: any) => c.dataset.panel === "night");
    expect((panel.body.innerHTML.match(/night-row/g) || []).length).toBe(3);

    const { ids: ids2, document: document2 } = fakeDoc();
    const ctx2: any = { ...ctx, document: document2, fetch: fetchFor({ ok: true, ranAt: null }) };
    vm.createContext(ctx2);
    vm.runInContext(src, ctx2);
    await ctx2.renderBoard(brief);
    expect(ids2.board.children.find((c: any) => c.dataset.panel === "night")).toBeUndefined();
  });
});

describe("links panel", () => {
  const brief = { ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } };

  it("renders bars for the top 3 edge types and a two-column list for the rest", async () => {
    const { ids, document } = fakeDoc();
    const edgeTypes = { relates_to: 2140, follows: 812, supersedes: 96, decided: 74, about_person: 60, part_of_project: 48, caused_by: 30 };
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) => (url.includes("/stats/graph") ? { ok: true, json: async () => ({ ok: true, edgeTypes }) } : { ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard(brief);
    const panel = ids.board.children.find((c: any) => c.dataset.panel === "links");
    expect(panel, "links panel should render").toBeTruthy();
    expect((panel.body.innerHTML.match(/class="bar"/g) || []).length).toBe(3);
    expect((panel.body.innerHTML.match(/link-chip"/g) || []).length).toBe(4);
    const connectionsTile = ids["board-tiles"].children.find((t: any) => t.dataset.tile === "connections");
    expect(connectionsTile, "the connections tile should reuse the same /stats/graph fetch").toBeTruthy();
  });

  it("hides when /stats/graph has no edgeTypes", async () => {
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
    await ctx.renderBoard(brief);
    expect(ids.board.children.find((c: any) => c.dataset.panel === "links")).toBeUndefined();
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
    const panel = ids.board.children.find((c: any) => c.dataset.panel === "graph");
    expect(panel).toBeTruthy();
    // The text fallback for the in-SVG cluster labels, which CSS hides below
    // 700px where there is no room to set them without overlap.
    const clusterLegend = panel.body.children.find((c: any) => c.className === "graph-cluster-legend num");
    expect(clusterLegend, "graph-cluster-legend should be present").toBeTruthy();
    expect(clusterLegend.textContent.length).toBeGreaterThan(0);
  });
});

describe("panel registration order", () => {
  it("renders every panel in the final reading order when every endpoint answers", async () => {
    const { ids, document } = fakeDoc();
    function nodesAndEdges(n: number) {
      const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, tags: [i % 2 ? "alpha" : "beta"], importance: i % 5 }));
      const edges = nodes.slice(1).map((node, i) => ({ source: nodes[i].id, target: node.id, weight: 1 }));
      return { nodes, edges };
    }
    const responses: Record<string, any> = {
      "/stats/graph": { ok: true, edgeTypes: { relates_to: 10, follows: 5 } },
      "/stats/recalled": { ok: true, total_recalls: 40, entries: [{ id: "a", content: "x".repeat(30), source: "claude-code", created_at: Date.now(), recall_count: 4 }] },
      "/stats/night": { ok: true, ranAt: Date.now(), linksInferred: 3, insightsProposed: 1, digestsWritten: 1, claimsFlagged: 1 },
      "/graph?limit=120": { ok: true, ...nodesAndEdges(8) },
      "/stats": { ok: true, digest_candidates: [{ tag: "second-brain", count: 12 }], unvectorized: 0, unclassified: 0 },
      "/integrations": { ok: true, integrations: [{ provider: "gmail", name: "Gmail", connected: true, lastSyncedAt: Date.now() }] },
      "/prompt-capsules/core": { ok: true, populated: true, sections: [{ slot: "identity", source_entry_id: "a" }], omitted_slots: [] },
    };
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) => {
        const hit = Object.keys(responses).find((path) => url.includes(path));
        return hit ? { ok: true, json: async () => responses[hit] } : { ok: false, status: 404, json: async () => ({}) };
      },
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
      activity: Array.from({ length: 14 }, (_, i) => ({ day: i, count: 5 })),
      sources: [],
      topics: [{ tag: "second-brain", count: 40 }],
      patterns: [{ id: "p1", content: "x".repeat(40) }],
      resurface: { id: "r1", content: "y".repeat(60), source: "claude-code", created_at: Date.now(), tags: [] },
      attention: { unindexed: 1, stale: 1, patterns: 1 },
    });
    expect(ids.board.children.map((c: any) => c.dataset.panel)).toEqual([
      "growth",
      "decide",
      "graph",
      "recalled",
      "night",
      "upkeep",
      "sources",
      "capsule",
      "reread",
      "links",
      "topics",
    ]);
    expect(ids["board-tiles"].children.map((c: any) => c.dataset.tile)).toEqual(["memories", "connections", "recalls"]);
  });
});
