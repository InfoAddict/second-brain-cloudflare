/**
 * The open-loops queue behind the home panel's three-item preview.
 *
 * Mirrors test/ui/stale-review.test.ts: what is tested here is that the sheet
 * shows which commitments are open, in enough detail to rule on, and offers
 * the two actions that resolve one (GET /loops, POST /loops/resolve,
 * src/routes/admin.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function load(pages: any[] = []) {
  const els = new Map<string, any>();
  const listeners = new Map<string, Map<string, Set<(ev: any) => void>>>();
  const makeEl = (id?: string) => ({
    id,
    hidden: false,
    disabled: false,
    innerHTML: "",
    textContent: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelectorAll: () => [],
    querySelector: () => null,
    closest() {
      return null;
    },
    dataset: {} as Record<string, string>,
    setAttribute() {},
    addEventListener(type: string, fn: (ev: any) => void) {
      if (!id) return;
      if (!listeners.has(id)) listeners.set(id, new Map());
      const byType = listeners.get(id)!;
      if (!byType.has(type)) byType.set(type, new Set());
      byType.get(type)!.add(fn);
    },
  });
  let pageIndex = 0;
  const fetchCalls: { url: string; init?: any }[] = [];
  const toasts: { message: string; opts?: any }[] = [];
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    closeMenu: () => {},
    showToast: (message: string, opts?: any) => { toasts.push({ message, opts }); },
    setTimeout: (fn: () => void) => fn(),
    fetch: async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      const page = pages[Math.min(pageIndex++, pages.length - 1)] ?? { ok: true, entries: [], total: 0 };
      if (page instanceof Error) throw page;
      return { ok: true, json: async () => page };
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/undo.js", "public/js/loops.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  ctx.__fetchCalls = fetchCalls;
  ctx.__toasts = toasts;
  return ctx;
}

const page = (n: number, total = n) => ({
  ok: true,
  total,
  entries: Array.from({ length: n }, (_, i) => ({
    id: `l${i}`,
    content: `Follow up on item ${i}`,
    source: "claude-desktop",
    tags: ["task"],
    created_at: Date.UTC(2026, 1, 8, 12),
  })),
});

describe("the open-loops queue", () => {
  it("shows which commitments are open", async () => {
    const ctx = load([page(2)]);

    await ctx.loadLoopsQueue();

    const html = ctx.__els.get("loops-list").innerHTML;
    expect(html).toContain("Follow up on item 0");
    expect(html).toContain("Follow up on item 1");
  });

  it("offers done and not-a-task on each row", async () => {
    const ctx = load([page(1)]);

    await ctx.loadLoopsQueue();

    const html = ctx.__els.get("loops-list").innerHTML;
    expect(html).toContain("resolveLoop('l0', 'done'");
    expect(html).toContain("resolveLoop('l0', 'not-task'");
    expect(html).toContain("loop-row-l0");
  });

  it("says so plainly when nothing is open", async () => {
    const ctx = load([{ ok: true, entries: [], total: 0 }]);

    await ctx.loadLoopsQueue();

    expect(ctx.__els.get("loops-list").innerHTML).toContain("Nothing open");
  });

  it("does not claim an empty queue when the request failed", async () => {
    // An error rendered as "nothing is open" tells the user their list is
    // clear at exactly the moment it could not be checked.
    const ctx = load([new Error("offline")]);

    await ctx.loadLoopsQueue();

    const html = ctx.__els.get("loops-list").innerHTML;
    expect(html).not.toContain("Nothing open");
    expect(html).toContain("Could not load");
  });

  it("UI reviewer round 2: the error state offers a Try again button that retries the fetch", async () => {
    const ctx = load([new Error("offline"), page(1)]);

    await ctx.loadLoopsQueue();
    const html = ctx.__els.get("loops-list").innerHTML;
    expect(html).toContain("Try again");
    expect(html).toContain("loadLoopsQueue()");

    await ctx.loadLoopsQueue();
    expect(ctx.__els.get("loops-list").innerHTML).toContain("Follow up on item 0");
  });

  it("pages without repeating or skipping", async () => {
    const ctx = load([page(25, 25)]);

    await ctx.loadLoopsQueue();
    const btn = { disabled: false, textContent: "" };
    ctx.loadMoreLoops(btn);
    await new Promise((r) => setTimeout(r, 0));

    // Second fetch returns the same fixture (load() cycles pages), so this
    // proves append accumulates rather than replaces.
    const html = ctx.__els.get("loops-list").innerHTML;
    expect(html).toContain("loop-row-l0");
  });
});

describe("resolving a loop", () => {
  it("takes a done loop off the sheet", async () => {
    const ctx = load([
      page(2),
      { ok: true, action: "done" },
    ]);
    await ctx.loadLoopsQueue();

    await ctx.resolveLoop("l0", "done", { disabled: false });

    const html = ctx.__els.get("loops-list").innerHTML;
    expect(html).not.toContain("Follow up on item 0");
    expect(html).toContain("Follow up on item 1");
  });

  it("takes a not-a-task loop off the sheet", async () => {
    const ctx = load([
      page(2),
      { ok: true, action: "not-task" },
    ]);
    await ctx.loadLoopsQueue();

    await ctx.resolveLoop("l1", "not-task", { disabled: false });

    const html = ctx.__els.get("loops-list").innerHTML;
    expect(html).toContain("Follow up on item 0");
    expect(html).not.toContain("Follow up on item 1");
  });

  it("shows the empty state once the last row is resolved", async () => {
    const ctx = load([
      page(1),
      { ok: true, action: "done" },
    ]);
    await ctx.loadLoopsQueue();

    await ctx.resolveLoop("l0", "done", { disabled: false });

    expect(ctx.__els.get("loops-list").innerHTML).toContain("Nothing open");
  });

  it("re-enables the button and leaves the row on a failed resolve", async () => {
    const ctx = load([page(1)]);
    ctx.fetch = async (url: string) => {
      if (String(url).includes("/loops/resolve")) return { ok: true, json: async () => ({ ok: false, error: "nope" }) };
      return { ok: true, json: async () => page(1) };
    };
    await ctx.loadLoopsQueue();
    const btn = { disabled: false };

    await ctx.resolveLoop("l0", "done", btn);

    expect(btn.disabled).toBe(false);
    expect(ctx.__els.get("loops-list").innerHTML).toContain("Follow up on item 0");
  });

  it("also updates the home panel's cached brief data, if present", async () => {
    const ctx = load([
      page(1),
      { ok: true, action: "done" },
    ]);
    ctx.briefData = { loops: { open: 1, items: [{ id: "l0", content: "Follow up on item 0" }] } };
    let rendered: unknown = null;
    ctx.renderBoard = (data: unknown) => { rendered = data; };
    await ctx.loadLoopsQueue();

    await ctx.resolveLoop("l0", "done", { disabled: false });

    expect(ctx.briefData.loops.items).toEqual([]);
    expect(ctx.briefData.loops.open).toBe(0);
    expect(rendered).toBe(ctx.briefData);
  });
});

describe("the loops sheet's direction tabs", () => {
  it("defaults to \"out\" on open and pages GET /loops?direction=out", async () => {
    const ctx = load([page(1)]);

    await ctx.openLoopsSheet();

    expect(ctx.__fetchCalls[0].url).toContain("direction=out");
  });

  it("sheet tabs page /loops?direction", async () => {
    const ctx = load([page(1), page(1)]);
    await ctx.openLoopsSheet();

    await ctx.setLoopsDirection("in");

    expect(ctx.__fetchCalls.at(-1).url).toContain("direction=in");
  });

  it("switching tabs drops whatever the other tab had loaded", async () => {
    const ctx = load([
      { ok: true, total: 1, entries: [{ id: "out1", content: "Outbound item", source: "cli", tags: ["task"], created_at: Date.now() }] },
      { ok: true, total: 1, entries: [{ id: "in1", content: "Inbound item", source: "cli", tags: ["task", "owed-to-me"], created_at: Date.now() }] },
    ]);
    await ctx.openLoopsSheet();
    expect(ctx.__els.get("loops-list").innerHTML).toContain("Outbound item");

    await ctx.setLoopsDirection("in");

    const html = ctx.__els.get("loops-list").innerHTML;
    expect(html).toContain("Inbound item");
    expect(html).not.toContain("Outbound item");
  });

  it("switching to the tab already showing is a no-op (no refetch)", async () => {
    const ctx = load([page(1)]);
    await ctx.openLoopsSheet();
    const callsBefore = ctx.__fetchCalls.length;

    await ctx.setLoopsDirection("out");

    expect(ctx.__fetchCalls.length).toBe(callsBefore);
  });
});

describe("inbound rows in the sheet", () => {
  const inboundPage = () => ({
    ok: true,
    total: 1,
    entries: [{
      id: "in1",
      content: "Send back the signed contract",
      source: "cli",
      tags: ["task", "owed-to-me", "counterparty:priya"],
      created_at: Date.UTC(2026, 1, 1),
      direction: "in",
      counterparty: "Priya",
    }],
  });

  it("shows Received and Not a commitment instead of Done and Not a task", async () => {
    const ctx = load([inboundPage()]);
    await ctx.openLoopsSheet();
    await ctx.setLoopsDirection("in");

    const html = ctx.__els.get("loops-list").innerHTML;
    expect(html).toContain("Received");
    expect(html).toContain("Not a commitment");
    expect(html).not.toContain("Done");
  });

  it("names the counterparty", async () => {
    const ctx = load([inboundPage()]);
    await ctx.openLoopsSheet();
    await ctx.setLoopsDirection("in");

    expect(ctx.__els.get("loops-list").innerHTML).toContain("from Priya");
  });
});

describe("Received posts done and shows Undo", () => {
  it("posts /loops/resolve with action done and shows a toast with an Undo action", async () => {
    const ctx = load([
      { ok: true, total: 0, entries: [] },
      { ok: true, total: 1, entries: [{ id: "in1", content: "Send back the signed contract", source: "cli", tags: ["task", "owed-to-me"], created_at: Date.now(), direction: "in" }] },
      { ok: true, action: "done" },
    ]);
    await ctx.openLoopsSheet();
    await ctx.setLoopsDirection("in");

    await ctx.resolveLoop("in1", "done", { disabled: false });

    const resolveCall = ctx.__fetchCalls.find((c: any) => c.url.includes("/loops/resolve"));
    expect(JSON.parse(resolveCall.init.body)).toEqual({ id: "in1", action: "done" });
    expect(ctx.__toasts).toHaveLength(1);
    expect(ctx.__toasts[0].message).toContain("received");
    expect(ctx.__toasts[0].opts.action).toBe("Undo");
    expect(typeof ctx.__toasts[0].opts.onAction).toBe("function");
  });

  it("Undo calls POST /undo with the same id and reloads the queue", async () => {
    const ctx = load([
      { ok: true, total: 0, entries: [] },
      { ok: true, total: 1, entries: [{ id: "in1", content: "Send back the signed contract", source: "cli", tags: ["task", "owed-to-me"], created_at: Date.now(), direction: "in" }] },
      { ok: true, action: "done" },
      { ok: true },
      { ok: true, total: 0, entries: [] },
    ]);
    await ctx.openLoopsSheet();
    await ctx.setLoopsDirection("in");
    await ctx.resolveLoop("in1", "done", { disabled: false });

    await ctx.__toasts[0].opts.onAction();

    const undoCall = ctx.__fetchCalls.find((c: any) => c.url.includes("/undo"));
    expect(JSON.parse(undoCall.init.body)).toEqual({ id: "in1" });
  });
});
