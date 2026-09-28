/**
 * The decision log's pure layout math (bucketRows, xScale) and its
 * calibration dot plot render (Design 4.4, 7.4). Mirrors test/ui/chart.test.ts's
 * shape: pure math tested with no DOM, the render tested against a small fake
 * DOM capable of querySelector/appendChild/addEventListener/dispatchEvent.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function load() {
  const ctx: any = { console };
  vm.createContext(ctx);
  installI18n(ctx, "en");
  vm.runInContext(readFileSync(resolve(ROOT, "public/utils.js"), "utf8"), ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/ledger.js"), "utf8"), ctx);
  return ctx;
}

const readyResult = () => ({
  ready: true,
  n: 14,
  nStated: 9,
  nInferred: 5,
  brier: 0.21,
  gap: 0.05,
  direction: "over",
  buckets: [
    { bucket: "50-59", n: 2, nStated: 1, nInferred: 1, meanStated: 0.55, hitRate: 0.5, ci: [0.2, 0.8], shown: false },
    { bucket: "60-69", n: 0, nStated: 0, nInferred: 0, meanStated: 0, hitRate: 0, ci: [0, 1], shown: false },
    { bucket: "70-79", n: 14, nStated: 9, nInferred: 5, meanStated: 0.74, hitRate: 0.52, ci: [0.3, 0.7], shown: true },
    { bucket: "80-89", n: 3, nStated: 2, nInferred: 1, meanStated: 0.85, hitRate: 0.6, ci: [0.2, 0.9], shown: false },
    { bucket: "90-95", n: 0, nStated: 0, nInferred: 0, meanStated: 0, hitRate: 0, ci: [0, 1], shown: false },
  ],
  headlineBucket: "70-79",
  topic: { name: "hiring", n: 6, gap: 0.1, direction: "over" },
  line: "So far, your 74% calls came true 52% of the time, based on 14 decisions.",
  topicLine: "On hiring, your calls have come true less often than you expected so far, based on 6 decisions.",
});

const notReadyResult = () => ({ ready: false, n: 4, needed: 10, line: "You'll see how your confidence compares with what happened after 10 reviewed decisions. You have 4 so far." });

describe("ledger math (pure, no DOM)", () => {
  it("round 4 (T7-C's real fields): calibrationSentence localizes the rate kind", () => {
    const { calibrationSentence } = load();

    const withFields = calibrationSentence({ line: "So far, your 74% calls came true 52% of the time, based on 14 decisions.", kind: "rate", stated: 74, hit: 52, n: 14 });

    expect(withFields).toBe("So far, when you were about 74% sure, you were right 52% of the time, based on 14 decisions.");
  });

  it("round 4: calibrationSentence localizes the in_line kind", () => {
    const { calibrationSentence } = load();

    const line = calibrationSentence({ line: "So far, how you did roughly matches how sure you were.", kind: "in_line", stated: null, hit: null, n: 9 });

    expect(line).toBe("So far, how sure you were roughly matches how things turned out, based on 9 decisions.");
  });

  it("round 4: calibrationSentence localizes the no_range kind", () => {
    const { calibrationSentence } = load();

    const line = calibrationSentence({ line: "You'll see how you did once you have enough similar calls.", kind: "no_range", stated: null, hit: null, n: 3 });

    expect(line).toBe("You'll see how often you're right once 5 decisions share a similar confidence. You have 3 so far.");
  });

  it("round 4: calibrationSentence falls back to the server's own sentence when kind is absent (a Worker that predates it)", () => {
    const { calibrationSentence } = load();

    const withoutFields = calibrationSentence({ line: "So far, your 74% calls came true 52% of the time, based on 14 decisions." });

    expect(withoutFields).toBe("So far, your 74% calls came true 52% of the time, based on 14 decisions.");
    expect(calibrationSentence(null)).toBe("");
  });

  it("bucketRows maps calibration JSON to rows; n<5 rows carry no marks", () => {
    const { bucketRows } = load();

    const rows = bucketRows(readyResult());

    expect(rows).toHaveLength(5);
    expect(rows.map((r: any) => r.bucket)).toEqual(["50-59", "60-69", "70-79", "80-89", "90-95"]);
    const shownRow = rows.find((r: any) => r.bucket === "70-79");
    expect(shownRow.shown).toBe(true);
    expect(shownRow.meanStated).toBe(0.74);
    expect(shownRow.hitRate).toBe(0.52);
    // Every bucket with n < 5 (the Worker's own CALIBRATION_MIN_BUCKET_N gate,
    // reported as shown: false) carries no marks at all.
    for (const row of rows.filter((r: any) => !r.shown)) {
      expect(row.meanStated).toBeNull();
      expect(row.hitRate).toBeNull();
    }
  });

  it("bucketRows returns no rows at all when not ready", () => {
    const { bucketRows } = load();

    expect(bucketRows(notReadyResult())).toEqual([]);
    expect(bucketRows(null)).toEqual([]);
    expect(bucketRows(undefined)).toEqual([]);
  });

  it("xScale 0-100%", () => {
    const { xScale } = load();

    expect(xScale(0)).toBe(0);
    expect(xScale(100)).toBe(1);
    expect(xScale(50)).toBe(0.5);
    // Clamped to the axis, not extrapolated past it.
    expect(xScale(-10)).toBe(0);
    expect(xScale(150)).toBe(1);
  });

  it("the tooltip text leads with the values, then names n and the stated/inferred split", () => {
    const { bucketRows, calibrationTooltipText } = load();
    const rows = bucketRows(readyResult());
    const shownRow = rows.find((r: any) => r.bucket === "70-79");

    const text = calibrationTooltipText(shownRow);

    expect(text.startsWith("70-79%:")).toBe(true);
    expect(text).toContain("you said 74%");
    expect(text).toContain("came true 52% of the time");
    expect(text).toContain("14 decisions");
    expect(text).toContain("9 stated, 5 estimated");
  });

  it("a not-enough-yet row's tooltip names n and carries no rate", () => {
    const { bucketRows, calibrationTooltipText } = load();
    const rows = bucketRows(readyResult());
    const thinRow = rows.find((r: any) => r.bucket === "50-59");

    const text = calibrationTooltipText(thinRow);

    expect(text).toContain("too few yet");
    expect(text).toContain("(2)");
    expect(text).not.toContain("came true");
  });
});

/**
 * A fake DOM capable enough to drive renderCalibrationChart end to end:
 * querySelector/querySelectorAll resolve into a real (if tiny) tree,
 * addEventListener/dispatchEvent work, matching test/ui/chart.test.ts's own
 * harness for renderActivityChart.
 */
function makeNode(tag = "div") {
  const node: any = {
    tag,
    className: "",
    children: [] as any[],
    attrs: {} as Record<string, string>,
    style: {},
    innerHTML: "",
    textContent: "",
    hidden: false,
    clientWidth: 320,
    scrollWidth: 320,
    parentElement: null as any,
    _listeners: {} as Record<string, Array<(e: any) => void>>,
    classList: {
      add(c: string) { if (!this.contains(c)) node.className = `${node.className} ${c}`.trim(); },
      remove(c: string) { node.className = node.className.split(/\s+/).filter((n: string) => n && n !== c).join(" "); },
      toggle(c: string, on?: boolean) { (on === undefined ? !this.contains(c) : on) ? this.add(c) : this.remove(c); },
      contains(c: string) { return node.className.split(/\s+/).includes(c); },
    },
    setAttribute(k: string, v: string) { node.attrs[k] = String(v); },
    getAttribute(k: string) { return node.attrs[k] ?? null; },
    appendChild(child: any) { child.parentElement = node; node.children.push(child); return child; },
    addEventListener(type: string, fn: (e: any) => void) { (node._listeners[type] ||= []).push(fn); },
    dispatchEvent(evt: any) { (node._listeners[evt.type] || []).forEach((fn: (e: any) => void) => fn(evt)); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 30 }; },
    querySelector(sel: string): any { return queryOne(node, sel); },
    querySelectorAll(sel: string): any[] { const out: any[] = []; collectAll(node, sel, out); return out; },
    closest(sel: string): any {
      let cur: any = node;
      while (cur) {
        if (matches(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    // innerHTML here is a plain string sink for tests that only check the SVG
    // markup (bucketRows/xScale already cover the geometry); it never gets
    // parsed back into children, so renderCalibrationChart's own DOM-tree
    // queries below target elements this test builds directly instead.
  };
  return node;
}
function matches(node: any, sel: string): boolean {
  if (sel.startsWith(".")) return ((node.attrs && node.attrs.class) || node.className || "").split(/\s+/).includes(sel.slice(1));
  if (sel.startsWith("#")) return node.attrs && node.attrs.id === sel.slice(1);
  return node.tag === sel;
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

function buildLedgerDom() {
  const wrap = makeNode("div");
  const legendEl = makeNode("div");
  legendEl.className = "legend";
  const scopeEl = makeNode("p");
  scopeEl.className = "ledger-chart-scope";
  const chartEl = makeNode("div");
  chartEl.className = "chart";
  const svg = makeNode("svg");
  chartEl.appendChild(svg);
  const tableScrollEl = makeNode("div");
  tableScrollEl.className = "ledger-table-scroll";
  const tableEl = makeNode("table");
  tableEl.className = "data-table";
  tableEl.appendChild(makeNode("caption"));
  tableEl.appendChild(makeNode("thead"));
  tableEl.appendChild(makeNode("tbody"));
  tableScrollEl.appendChild(tableEl);
  wrap.appendChild(legendEl);
  wrap.appendChild(scopeEl);
  wrap.appendChild(chartEl);
  wrap.appendChild(tableScrollEl);
  return { wrap, legendEl, scopeEl, chartEl, svg, tableEl, tableScrollEl };
}

function loadWithDom(extraIds: Record<string, any> = {}) {
  const src = ["public/js/i18n.js", "public/utils.js", "public/js/ledger.js"]
    .map((f) => readFileSync(resolve(ROOT, f), "utf8"))
    .join("\n");
  const ids: Record<string, any> = { "board-tip": makeNode("div"), ...extraIds };
  const ctx: any = {
    console,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: "en-US" },
    document: {
      createElement: (tag: string) => makeNode(tag),
      createElementNS: (_ns: string, tag: string) => makeNode(tag),
      getElementById: (id: string) => ids[id] ?? null,
      documentElement: { lang: "en" },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.__ids = ids;
  return ctx;
}

describe("renderCalibrationChart", () => {
  it("legend always present; no value labels on dots", () => {
    const ctx = loadWithDom();
    const { chartEl, legendEl, svg } = buildLedgerDom();

    ctx.renderCalibrationChart(chartEl, readyResult());

    expect(legendEl.innerHTML).toContain("You said");
    expect(legendEl.innerHTML).toContain("Came true");
    // Direct labels are the n per row only — no "74%"/"52%" printed on the marks themselves.
    expect(svg.innerHTML).not.toMatch(/>74%</);
    expect(svg.innerHTML).not.toMatch(/>52%</);
    expect(svg.innerHTML).toContain(">14<");
  });

  it("UX advisor round 2: no legend when not ready, only once the chart itself is drawn", () => {
    const ctx = loadWithDom();
    const { chartEl, legendEl } = buildLedgerDom();
    legendEl.innerHTML = "<span>stale</span>"; // simulate a previous ready render

    ctx.renderCalibrationChart(chartEl, notReadyResult());
    expect(legendEl.innerHTML).toBe("");

    ctx.renderCalibrationChart(chartEl, readyResult());
    expect(legendEl.innerHTML).toContain("You said");
    expect(legendEl.innerHTML).toContain("Came true");
  });

  it("not-ready state draws no chart", () => {
    const ctx = loadWithDom();
    const { chartEl, svg, tableEl } = buildLedgerDom();
    svg.innerHTML = "<circle/>"; // simulate a stale previous render

    ctx.renderCalibrationChart(chartEl, notReadyResult());

    expect(svg.innerHTML).toBe("");
    expect(tableEl.children.find((c: any) => c.tag === "tbody").innerHTML).toBe("");
  });

  it("table view mirrors every value, shown or not", () => {
    const ctx = loadWithDom();
    const { chartEl, tableEl } = buildLedgerDom();

    ctx.renderCalibrationChart(chartEl, readyResult());

    const tbody = tableEl.children.find((c: any) => c.tag === "tbody").innerHTML;
    // A shown bucket's real values.
    expect(tbody).toContain("70-79%");
    expect(tbody).toContain("74%");
    expect(tbody).toContain("52%");
    expect(tbody).toContain("9/5");
    // An unshown bucket still gets its own row, too few yet rather than a value.
    expect(tbody).toContain("50-59%");
    expect(tbody).toContain("too few yet");
  });

  it("tooltip text leads with values and uses textContent, on hover and on focus", () => {
    const tip = makeNode("div");
    const ctx = loadWithDom({ "board-tip": tip });
    const { chartEl, svg } = buildLedgerDom();

    ctx.renderCalibrationChart(chartEl, readyResult());
    const rowHit = svg.querySelectorAll(".cal-row-hit").find((g: any) => g.attrs["data-row"] === "2"); // 70-79 is the 3rd bucket

    rowHit.dispatchEvent({ type: "mouseenter" });
    expect(tip.textContent).toContain("you said 74%");
    expect(tip.textContent).toContain("came true 52%");
    expect(tip.classList.contains("on")).toBe(true);

    rowHit.dispatchEvent({ type: "mouseleave" });
    expect(tip.classList.contains("on")).toBe(false);

    rowHit.dispatchEvent({ type: "focus" });
    expect(tip.textContent).toContain("you said 74%");
    rowHit.dispatchEvent({ type: "blur" });
    expect(tip.classList.contains("on")).toBe(false);
  });
});

describe("the ledger sheet's filters (source, state)", () => {
  function harness() {
    const els: Record<string, any> = {
      "ledger-sentence": makeNode("p"),
      "ledger-topic": makeNode("p"),
      "ledger-caption": makeNode("p"),
      "ledger-list": makeNode("div"),
      "board-tip": makeNode("div"),
      "loops-sheet": makeNode("div"), // unused, but keeps getElementById total generic
    };
    const { wrap, legendEl, scopeEl, chartEl, svg, tableEl, tableScrollEl } = buildLedgerDom();
    els["ledger-chart"] = chartEl;
    els["ledger-chart-wrap"] = wrap;
    (chartEl as any).parentElement = wrap;
    ["ledger-source-all", "ledger-source-stated", "ledger-source-inferred", "ledger-state-open", "ledger-state-resolved", "ledger-table-toggle", "ledger-sheet"].forEach((id) => {
      els[id] = makeNode("button");
    });
    const fetchCalls: string[] = [];
    const responses: Record<string, any> = {};
    const src = ["public/js/i18n.js", "public/utils.js", "public/js/ledger.js"].map((f) => readFileSync(resolve(ROOT, f), "utf8")).join("\n");
    const ctx: any = {
      console,
      localStorage: { getItem: () => null, setItem() {} },
      navigator: { language: "en-US" },
      WORKER_URL: "https://example.test",
      AUTH_TOKEN: "t",
      closeMenu: () => {},
      fetch: async (url: string) => {
        fetchCalls.push(url);
        if (url.includes("/decisions/calibration")) return { ok: true, json: async () => ({ ok: true, ...responses.calibration }) };
        return { ok: true, json: async () => ({ ok: true, decisions: responses.decisions ?? [], total: (responses.decisions ?? []).length, limit: 50, offset: 0 }) };
      },
      document: {
        createElement: (tag: string) => makeNode(tag),
        createElementNS: (_ns: string, tag: string) => makeNode(tag),
        getElementById: (id: string) => els[id] ?? null,
        documentElement: { lang: "en" },
      },
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    return { ctx, els, fetchCalls, responses, svg, legendEl, scopeEl, tableEl, tableScrollEl, wrap };
  }

  it("source filter re-renders sentence, chart and list together", async () => {
    const { ctx, els, fetchCalls, responses } = harness();
    responses.calibration = readyResult();
    responses.decisions = [{ id: "d1", content: "Decided to hire Dana", created_at: Date.now(), confidence: 0.7, confidence_source: "stated", outcome: null, review_at: Date.UTC(2026, 11, 26, 12), rearms: 0, edited_since_recorded: false }];
    await ctx.openLedgerSheet();
    fetchCalls.length = 0;
    responses.calibration = { ...readyResult(), line: "Stated-only line." };
    responses.decisions = [];

    await ctx.setLedgerSource("stated");

    expect(fetchCalls.some((u) => u.includes("source=stated"))).toBe(true);
    // All three surfaces reflect the new fetch's data, not the previous one's.
    expect(els["ledger-sentence"].textContent).toBe("Stated-only line.");
    expect(els["ledger-list"].innerHTML).toContain("No decisions waiting for review");
  });

  it("switching state re-fetches and re-renders too, and a repeat of the same tab is a no-op", async () => {
    const { ctx, fetchCalls, responses } = harness();
    responses.calibration = readyResult();
    responses.decisions = [];
    await ctx.openLedgerSheet();
    const callsAfterOpen = fetchCalls.length;

    await ctx.setLedgerState("open"); // already showing "open": no-op
    expect(fetchCalls.length).toBe(callsAfterOpen);

    await ctx.setLedgerState("resolved");
    expect(fetchCalls.some((u) => u.includes("state=resolved"))).toBe(true);
  });

  it("UX advisor round 2: empty Open tab has its own line, not the onboarding line", async () => {
    const { ctx, els, responses } = harness();
    responses.calibration = notReadyResult();
    responses.decisions = [];

    await ctx.openLedgerSheet();

    expect(els["ledger-list"].innerHTML).toContain("No decisions waiting for review");
    expect(els["ledger-list"].innerHTML).not.toContain("No decisions yet");
  });

  it("empty Resolved tab keeps the fuller onboarding line", async () => {
    const { ctx, els, responses } = harness();
    responses.calibration = notReadyResult();
    responses.decisions = [];
    await ctx.openLedgerSheet();

    await ctx.setLedgerState("resolved");

    expect(els["ledger-list"].innerHTML).toContain("No decisions yet");
  });

  it("lists an open decision's review date and a resolved one's outcome chip", async () => {
    const { ctx, els, responses } = harness();
    responses.calibration = notReadyResult();
    responses.decisions = [
      { id: "d1", content: "Decided to hire Dana", created_at: Date.now(), confidence: 0.7, confidence_source: "stated", outcome: null, review_at: Date.UTC(2026, 11, 26, 12), rearms: 0, edited_since_recorded: false },
      { id: "d2", content: "Decided to ship the redesign early", created_at: Date.now(), confidence: null, confidence_source: null, outcome: "right", review_at: null, rearms: 0, edited_since_recorded: true },
    ];

    await ctx.openLedgerSheet();

    const html = els["ledger-list"].innerHTML;
    expect(html).toContain("Review around Dec 26");
    expect(html).toContain("70%");
    expect(html).toContain("stated");
    expect(html).toContain("Right call");
    expect(html).toContain("no percentage given");
    expect(html).toContain("Edited after it was logged");
  });

  it("UX advisor round 2: the calibration block (wrap) is hidden while its own fetch is in flight, and while it awaits", async () => {
    const { ctx, els, responses } = harness();
    let resolveCalibration: (() => void) | undefined;
    responses.calibration = readyResult();
    responses.decisions = [];
    const realFetch = ctx.fetch;
    ctx.fetch = async (url: string) => {
      if (url.includes("/decisions/calibration")) {
        await new Promise<void>((resolve) => { resolveCalibration = resolve; });
      }
      return realFetch(url);
    };

    const openPromise = ctx.openLedgerSheet();
    // Still in flight: hidden, and no blank chart/legend showing underneath.
    expect(els["ledger-chart-wrap"].hidden).toBe(true);

    resolveCalibration!();
    await openPromise;
    expect(els["ledger-chart-wrap"].hidden).toBe(false);
  });

  it("UX advisor round 2: a calibration-only failure drops the chart quietly and still shows the list", async () => {
    const { ctx, els, responses } = harness();
    responses.decisions = [{ id: "d1", content: "Decided to hire Dana", created_at: Date.now(), confidence: 0.7, confidence_source: "stated", outcome: null, review_at: Date.UTC(2026, 11, 26, 12), rearms: 0, edited_since_recorded: false }];
    ctx.fetch = async (url: string) => {
      if (url.includes("/decisions/calibration")) throw new Error("network down");
      return { ok: true, json: async () => ({ ok: true, decisions: responses.decisions, total: 1, limit: 50, offset: 0 }) };
    };

    await ctx.openLedgerSheet();

    expect(els["ledger-chart-wrap"].hidden).toBe(true);
    expect(els["ledger-sentence"].textContent).toBe("");
    // No error text of its own on the sentence line, and the list still rendered.
    expect(els["ledger-list"].innerHTML).toContain("Decided to hire Dana");
  });

  it("UX advisor round 2: the chart carries a scope note explaining it is not tab-scoped", async () => {
    const { ctx, scopeEl, responses } = harness();
    responses.calibration = readyResult();
    responses.decisions = [];

    await ctx.openLedgerSheet();

    expect(scopeEl.textContent).toContain("on both the Open and Reviewed tabs");
  });

  it("UI reviewer round 2: the list's own error state offers a Try again button that retries", async () => {
    const { ctx, els, responses } = harness();
    responses.calibration = notReadyResult();
    let listCalls = 0;
    ctx.fetch = async (url: string) => {
      if (url.includes("/decisions/calibration")) return { ok: true, json: async () => ({ ok: true, ...responses.calibration }) };
      listCalls++;
      if (listCalls === 1) throw new Error("offline");
      return { ok: true, json: async () => ({ ok: true, decisions: [{ id: "d1", content: "Decided to hire Dana", created_at: Date.now(), confidence: 0.7, confidence_source: "stated", outcome: null, review_at: null, rearms: 0, edited_since_recorded: false }], total: 1, limit: 50, offset: 0 }) };
    };

    await ctx.openLedgerSheet();
    const html = els["ledger-list"].innerHTML;
    expect(html).toContain("Could not load the decision log");
    expect(html).toContain("loadLedgerList()");

    await ctx.loadLedgerList();
    expect(els["ledger-list"].innerHTML).toContain("Decided to hire Dana");
  });
});
