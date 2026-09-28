/**
 * T7-E Task 14 (15-t7-wow-spec.md 7.3): standing instructions in the
 * dashboard - a "Standing" badge on cards, a firing-state filter fed by
 * GET /standing, a Stop control on the memory sheet, and the recall card
 * that renders above the results when /recall returns `standing`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

/** Auto-vivifying fake element: querySelector never returns null, so wiring an onclick after innerHTML never throws. Matches bulk-select.test.ts's own harness. */
function makeEl(tag = "div") {
  const kids: any[] = [];
  const children = new Map<string, any>();
  const el: any = {
    tag,
    id: "",
    className: "",
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains: () => false,
    },
    style: {} as Record<string, string>,
    disabled: false,
    hidden: false,
    title: "",
    value: "",
    textContent: "",
    onclick: null,
    attrs: {} as Record<string, string>,
    kids,
    dataset: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      el.attrs[k] = String(v);
    },
    getAttribute: (k: string) => el.attrs[k] ?? null,
    addEventListener() {},
    appendChild(c: any) {
      kids.push(c);
      return c;
    },
    remove() {},
    focus() {},
    closest: () => null,
    querySelector(sel: string) {
      if (!children.has(sel)) children.set(sel, makeEl("button"));
      return children.get(sel);
    },
    querySelectorAll: () => [],
  };
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get: () => html,
    set(v: string) {
      html = String(v);
      kids.length = 0;
    },
  });
  return el;
}

function baseCtx() {
  const els = new Map<string, any>();
  const toasts: Array<{ message: string; opts?: any }> = [];
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    TEAM_MODE: false,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: "en-US" },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    document: {
      documentElement: { lang: "en" },
      getElementById(id: string) {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: (tag: string) => makeEl(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: { appendChild() {} },
    },
    showToast: (message: string, opts?: any) => {
      toasts.push({ message, opts });
    },
  };
  ctx.__stubShowToast = ctx.showToast;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  ctx.__els = els;
  ctx.__toasts = toasts;
  return ctx;
}

function run(ctx: any, files: string[]) {
  for (const f of files) vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  // public/js/state.js declares `let WORKER_URL = '', AUTH_TOKEN = ''`, which
  // shadows whatever baseCtx set before contextifying — re-assert after every
  // load, the same way recent-author-filter.test.ts's own harness does.
  vm.runInContext('WORKER_URL = "https://example.test"; AUTH_TOKEN = "t";', ctx);
  if (typeof ctx.applyCardAuthorLock !== "function") ctx.applyCardAuthorLock = () => false;
  // public/js/toast.js's real `function showToast` overwrites the stub above
  // when loaded; restore it so toasts are captured instead of hitting the DOM.
  ctx.showToast = ctx.__stubShowToast;
}

describe("badge on standing cards only", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js"]);
    return ctx;
  }

  it("standingBadgeHtml renders the chip only when standing:active is present", () => {
    const ctx = load();
    expect(ctx.standingBadgeHtml(["standing:active"])).toContain("Standing");
    expect(ctx.standingBadgeHtml(["standing:active"])).toContain("ti-pin");
    expect(ctx.standingBadgeHtml(["work"])).toBe("");
    expect(ctx.standingBadgeHtml([])).toBe("");
    expect(ctx.standingBadgeHtml(undefined)).toBe("");
  });

  it("case-insensitive, matching the worker-owned tag exactly", () => {
    const ctx = load();
    expect(ctx.standingBadgeHtml(["Standing:Active"])).toContain("Standing");
  });

  it("makeRecentCard shows the badge on a standing memory and not on an ordinary one", () => {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/recent.js"]);
    const standing = ctx.makeRecentCard({ id: "m1", content: "When choosing a database, prefer boring tech", tags: '["standing:active"]', created_at: Date.now(), source: "claude-desktop" });
    const ordinary = ctx.makeRecentCard({ id: "m2", content: "The pricing floor is $6k", tags: '["work"]', created_at: Date.now(), source: "claude-desktop" });
    expect(standing.innerHTML).toContain("tag-chip--standing");
    expect(ordinary.innerHTML).not.toContain("tag-chip--standing");
  });

  it("makeRecallCard shows the badge on a standing memory and not on an ordinary one", () => {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/recall.js"]);
    const standing = ctx.makeRecallCard({ id: "m1", content: "When choosing a database, prefer boring tech", tags: ["standing:active"], score: 80, hop: 0, created_at: Date.now(), source: "claude-desktop" });
    const ordinary = ctx.makeRecallCard({ id: "m2", content: "The pricing floor is $6k", tags: ["work"], score: 80, hop: 0, created_at: Date.now(), source: "claude-desktop" });
    expect(standing.innerHTML).toContain("tag-chip--standing");
    expect(ordinary.innerHTML).not.toContain("tag-chip--standing");
  });
});

describe("filter lists firing state from /standing", () => {
  function load(response: unknown) {
    const ctx = baseCtx();
    const fetchCalls: string[] = [];
    ctx.fetch = async (url: string) => {
      fetchCalls.push(url);
      if (response instanceof Error) throw response;
      return { ok: true, json: async () => response };
    };
    ctx.openView = vi.fn();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/recent.js"]);
    ctx.__fetchCalls = fetchCalls;
    return ctx;
  }

  const item = (over: Record<string, unknown> = {}) => ({
    id: "s1",
    content: "When choosing a database, prefer boring tech",
    created_at: Date.now(),
    project: null,
    workspace: "personal",
    actor_name: null,
    firing: true,
    ...over,
  });

  it("fetches GET /standing and shows each item's firing state", async () => {
    const ctx = load({ ok: true, max: 50, standing: [item({ id: "s1", firing: true }), item({ id: "s2", firing: false, reason: "over_limit" })] });

    await ctx.loadStandingFilter();

    expect(ctx.__fetchCalls[0]).toContain("/standing");
    // innerHTML was cleared and rows appended via appendChild in this harness,
    // so read the rows straight off the tracked children instead.
    const rows = ctx.__els.get("recent-list").kids;
    expect(rows).toHaveLength(2);
    expect(rows[0].innerHTML).toContain("In use");
    expect(rows[1].innerHTML).toContain("Not in use: only 50 can be active");
  });

  it("names 'not in use yet: still being indexed' and a held reason", async () => {
    const ctx = load({ ok: true, standing: [item({ id: "s1", firing: false, reason: "not_indexed_yet" }), item({ id: "s2", firing: false, reason: "held" })] });

    await ctx.loadStandingFilter();

    const rows = ctx.__els.get("recent-list").kids;
    expect(rows[0].innerHTML).toContain("Not in use yet: still being indexed");
    expect(rows[1].innerHTML).toContain("Held");
  });

  it("leaves the {max} placeholder literal rather than guessing a number when GET /standing omits max (an older Worker)", async () => {
    const ctx = load({ ok: true, standing: [item({ id: "s1", firing: false, reason: "over_limit" })] });

    await ctx.loadStandingFilter();

    const rows = ctx.__els.get("recent-list").kids;
    expect(rows[0].innerHTML).not.toMatch(/only \d+ can be active/);
    expect(rows[0].innerHTML).toContain("{max}");
  });

  it("shows the empty state when there are no standing instructions", async () => {
    const ctx = load({ ok: true, standing: [] });

    await ctx.loadStandingFilter();

    expect(ctx.__els.get("recent-list").innerHTML).toContain("No standing instructions yet");
  });

  it("shows an error with a retry on failure, not the empty state", async () => {
    const ctx = load(new Error("offline"));

    await ctx.loadStandingFilter();

    const html = ctx.__els.get("recent-list").innerHTML;
    expect(html).toContain("Could not load standing instructions");
    expect(html).not.toContain("No standing instructions yet");
    expect(html).toContain("loadStandingFilter()");
  });

  it("opens the memory sheet when a row is clicked", async () => {
    const ctx = load({ ok: true, standing: [item({ id: "s1" })] });

    await ctx.loadStandingFilter();
    const row = ctx.__els.get("recent-list").kids[0];
    row.onclick();

    expect(ctx.openView).toHaveBeenCalledTimes(1);
    expect(ctx.openView.mock.calls[0][0].id).toBe("s1");
  });

  it("loadRecent routes to the standing filter instead of GET /list when selectedTag is standing:active", async () => {
    const ctx = load({ ok: true, standing: [item()] });
    vm.runInContext("selectedTag = 'standing:active'", ctx);

    await ctx.loadRecent();

    expect(ctx.__fetchCalls[0]).toContain("/standing");
    expect(ctx.__fetchCalls.some((u: string) => u.includes("/list"))).toBe(false);
  });
});

describe("Stop posts /standing/stop and shows Undo", () => {
  function load(response: unknown) {
    const ctx = baseCtx();
    const fetchCalls: { url: string; init?: any }[] = [];
    ctx.fetch = async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      if (response instanceof Error) throw response;
      return { ok: true, json: async () => response };
    };
    ctx.hydrateView = vi.fn();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/toast.js", "public/js/undo.js", "public/js/memory-crud.js"]);
    ctx.__fetchCalls = fetchCalls;
    return ctx;
  }

  const entry = { id: "m1", content: "When choosing a database, prefer boring tech", tags: ["standing:active"] };

  it("posts the id and shows a toast with an Undo action", async () => {
    const ctx = load({ ok: true, id: "m1" });

    await ctx.stopStanding(entry, { disabled: false });

    expect(ctx.__fetchCalls[0].url).toBe("https://example.test/standing/stop");
    expect(JSON.parse(ctx.__fetchCalls[0].init.body)).toEqual({ id: "m1" });
    expect(ctx.__toasts).toHaveLength(1);
    expect(ctx.__toasts[0].message).toBe("Stopped. The memory stays.");
    expect(ctx.__toasts[0].opts.action).toBe("Undo");
    expect(typeof ctx.__toasts[0].opts.onAction).toBe("function");
  });

  it("re-enables the button and shows a failure toast on error", async () => {
    const ctx = load({ ok: false, error: "nope" });
    const btn = { disabled: false };

    await ctx.stopStanding(entry, btn);

    expect(btn.disabled).toBe(false);
    expect(ctx.__toasts).toHaveLength(1);
    expect(ctx.__toasts[0].message).toContain("Could not stop this");
  });

  it("renderViewStanding shows the line and button only when standing:active is present", () => {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/toast.js", "public/js/undo.js", "public/js/memory-crud.js"]);

    ctx.renderViewStanding({ id: "m1", tags: ["standing:active"] });
    expect(ctx.__els.get("view-standing").style.display).toBe("");
    expect(ctx.__els.get("view-standing-line").textContent).toBe("Standing instruction · comes up when this topic does");

    ctx.renderViewStanding({ id: "m2", tags: ["work"] });
    expect(ctx.__els.get("view-standing").style.display).toBe("none");
  });

  it("UI reviewer: the sheet updates in place the moment Stop succeeds, before the round trip settles", async () => {
    const ctx = load({ ok: true, id: "m1" });
    ctx.renderViewStanding(entry); // the sheet is open on a standing memory, as it would be before Stop is clicked

    await ctx.stopStanding(entry, { disabled: false });

    const block = ctx.__els.get("view-standing");
    expect(block.style.display).toBe("");
    expect(ctx.__els.get("view-standing-line").textContent).toBe("No longer a standing instruction");
    expect(ctx.__els.get("view-standing-stop").style.display).toBe("none");
  });

  it("Undo restores both the line and the Stop button", async () => {
    const ctx = load({ ok: true, id: "m1" });
    ctx.renderViewStanding(entry);
    await ctx.stopStanding(entry, { disabled: false });

    await ctx.__toasts[0].opts.onAction();
    // hydrateView's own re-fetch is exercised in memory-crud's other tests;
    // what this proves is that onUndone clears the "just stopped" flag so
    // the next render (hydrateView's real one, once its fetch answers) reads
    // as standing again rather than staying on the acknowledgment.
    ctx.renderViewStanding(entry);
    expect(ctx.__els.get("view-standing-line").textContent).toBe("Standing instruction · comes up when this topic does");
    expect(ctx.__els.get("view-standing-stop").style.display).toBe("");
  });

  it("a memory that was never standing shows no line at all, only one that was just stopped in this session", () => {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/toast.js", "public/js/undo.js", "public/js/memory-crud.js"]);

    ctx.renderViewStanding({ id: "ordinary", tags: ["work"] });

    expect(ctx.__els.get("view-standing").style.display).toBe("none");
  });

  it("opening a different memory clears the just-stopped acknowledgment", async () => {
    const ctx = baseCtx();
    ctx.fetch = async () => ({ ok: true, json: async () => ({ ok: true, id: "m1" }) });
    ctx.hydrateView = () => {};
    ctx.applyCardAuthorLock = () => false;
    ctx.loadRelated = () => {};
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/toast.js", "public/js/undo.js", "public/js/memory-crud.js"]);

    await ctx.stopStanding({ id: "m1", tags: ["standing:active"] }, { disabled: false });
    expect(ctx.__els.get("view-standing").style.display).toBe(""); // just stopped: acknowledged in place

    ctx.openView({ id: "m2", tags: ["work"], content: "" });

    expect(ctx.__els.get("view-standing").style.display).toBe("none");
  });
});

describe("recall card renders from /recall standing", () => {
  function load() {
    const ctx = baseCtx();
    ctx.openView = vi.fn();
    const fetchCalls: { url: string; init?: any }[] = [];
    ctx.fetch = async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, id: "s1" }) };
    };
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/toast.js", "public/js/recall.js"]);
    ctx.__fetchCalls = fetchCalls;
    return ctx;
  }

  const fire = (over: Record<string, unknown> = {}) => ({
    id: "s1",
    content: "When choosing a database, prefer boring tech",
    created_at: Date.now(),
    workspace: "personal",
    project: null,
    score: 74,
    ...over,
  });

  it("renders one card per fire, above the results, with the text, Open and Stop", () => {
    const ctx = load();
    const container = ctx.document.createElement("div");

    ctx.renderStandingFires(container, [fire()]);

    expect(container.kids).toHaveLength(1);
    const html = container.kids[0].innerHTML;
    expect(html).toContain("When choosing a database, prefer boring tech");
    expect(html).toContain("Standing instruction");
    expect(html).toContain("Open");
    expect(html).toContain("Stop");
  });

  it('never claims "you set" - the server cannot verify authorship', () => {
    const ctx = load();
    const container = ctx.document.createElement("div");

    ctx.renderStandingFires(container, [fire()]);

    expect(container.kids[0].innerHTML).not.toContain("you set");
  });

  it("labels a company fire by someone else with their name", () => {
    const ctx = load();
    const container = ctx.document.createElement("div");

    ctx.renderStandingFires(container, [fire({ workspace: "company", actor_name: "Dana" })]);

    expect(container.kids[0].innerHTML).toContain("Dana");
  });

  it("renders nothing when there are no fires", () => {
    const ctx = load();
    const container = ctx.document.createElement("div");

    ctx.renderStandingFires(container, undefined);
    ctx.renderStandingFires(container, []);

    expect(container.kids).toHaveLength(0);
  });

  it("Open opens the memory sheet for that instruction", () => {
    const ctx = load();
    const container = ctx.document.createElement("div");
    ctx.renderStandingFires(container, [fire()]);
    const card = container.kids[0];

    card.querySelector(".standing-card-open").onclick();

    expect(ctx.openView).toHaveBeenCalledTimes(1);
    expect(ctx.openView.mock.calls[0][0].id).toBe("s1");
  });

  it("Stop posts /standing/stop for that instruction and removes the card", async () => {
    const ctx = load();
    const container = ctx.document.createElement("div");
    ctx.renderStandingFires(container, [fire()]);
    const card = container.kids[0];
    let removed = false;
    card.remove = () => { removed = true; };

    await card.querySelector(".standing-card-stop").onclick();

    expect(ctx.__fetchCalls[0].url).toBe("https://example.test/standing/stop");
    expect(JSON.parse(ctx.__fetchCalls[0].init.body)).toEqual({ id: "s1" });
    expect(removed).toBe(true);
  });
});

describe("keyboard: Stop and the card actions are focusable with names", () => {
  it("the recall standing card's Open and Stop are real buttons with visible text", () => {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/toast.js", "public/js/recall.js"]);
    const container = ctx.document.createElement("div");

    ctx.renderStandingFires(container, [{ id: "s1", content: "text", created_at: Date.now(), workspace: "personal", project: null, score: 70 }]);

    const html = container.kids[0].innerHTML;
    expect(html).toMatch(/<button type="button" class="[^"]*standing-card-open[^"]*">Open<\/button>/);
    expect(html).toMatch(/<button type="button" class="[^"]*standing-card-stop[^"]*">Stop<\/button>/);
  });

  it("the memory sheet's Stop button is a real button with visible text, not an icon alone", () => {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/toast.js", "public/js/undo.js", "public/js/memory-crud.js"]);
    ctx.renderViewStanding({ id: "m1", tags: ["standing:active"] });
    const btn = ctx.__els.get("view-standing-stop");
    expect(typeof btn.onclick).toBe("function");
  });
});
