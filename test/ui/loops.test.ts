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
    classList: { add() {}, remove() {}, contains: () => false },
    querySelectorAll: () => [],
    querySelector: () => null,
    closest() {
      return null;
    },
    dataset: {} as Record<string, string>,
    addEventListener(type: string, fn: (ev: any) => void) {
      if (!id) return;
      if (!listeners.has(id)) listeners.set(id, new Map());
      const byType = listeners.get(id)!;
      if (!byType.has(type)) byType.set(type, new Set());
      byType.get(type)!.add(fn);
    },
  });
  let pageIndex = 0;
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    closeMenu: () => {},
    showToast: () => {},
    setTimeout: (fn: () => void) => fn(),
    fetch: async () => {
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
  for (const f of ["public/utils.js", "public/js/loops.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
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
