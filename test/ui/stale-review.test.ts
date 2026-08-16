/**
 * The out-of-date review queue.
 *
 * The chip on home says "N may be out of date". Clicking it used to fire a
 * free-text recall for that phrase — a vector search which returns the flagged
 * entries only by coincidence, and on a real brain returned two memories that
 * merely contained the words while the one actually flagged never appeared.
 *
 * What is tested here is the thing that made the chip useless: that the queue
 * shows WHICH memory is flagged, in enough detail to rule on, and offers the
 * three actions that resolve it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function load(pages: any[] = []) {
  const els = new Map<string, any>();
  const makeEl = () => ({
    hidden: false,
    disabled: false,
    innerHTML: "",
    textContent: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, contains: () => false },
    querySelectorAll: () => [],
  });
  let pageIndex = 0;
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    closeMenu: () => {},
    openMenu: () => {},
    refreshAll: () => {},
    setTimeout: (fn: () => void) => fn(),
    fetch: async () => {
      const page = pages[Math.min(pageIndex++, pages.length - 1)] ?? { ok: true, entries: [], total: 0 };
      if (page instanceof Error) throw page;
      return { ok: true, json: async () => page };
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
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
  for (const f of ["public/utils.js", "public/js/stale.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

const page = (n: number, total = n) => ({
  ok: true,
  total,
  entries: Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    content: `Our deploy target is the staging cluster ${i}`,
    tags: ["work", "stale:as-of"],
    source: "claude-desktop",
    created_at: Date.UTC(2026, 1, 8, 12),
    last_updated: Date.UTC(2026, 1, 8, 12),
  })),
});

describe("the out-of-date queue", () => {
  it("shows which memory is flagged, not a search for the phrase", async () => {
    const ctx = load([page(2)]);

    await ctx.loadStaleQueue();

    const html = ctx.__els.get("stale-list").innerHTML;
    expect(html).toContain("Our deploy target is the staging cluster 0");
    expect(html).toContain("Our deploy target is the staging cluster 1");
  });

  it("offers edit, append and forget on each flagged memory", async () => {
    // The three actions the queue exists to make reachable. Without them it is a
    // list of problems with no way to resolve one.
    const ctx = load([page(1)]);

    await ctx.loadStaleQueue();

    const html = ctx.__els.get("stale-list").innerHTML;
    expect(html).toContain("openEdit(");
    expect(html).toContain("openAppend(");
    expect(html).toContain("openConfirm(");
    // Wired to the entry, not to the row index.
    expect(html).toContain("s0");
  });

  it("says when the entry was last confirmed", async () => {
    // "Out of date" is a claim about age. A reviewer cannot rule on it without
    // seeing how long it has been since anyone touched the memory.
    const ctx = load([page(1)]);

    await ctx.loadStaleQueue();

    expect(ctx.__els.get("stale-list").innerHTML).toContain("Feb 8, 2026");
  });

  it("says so plainly when nothing is flagged", async () => {
    const ctx = load([{ ok: true, entries: [], total: 0 }]);

    await ctx.loadStaleQueue();

    const html = ctx.__els.get("stale-list").innerHTML;
    expect(html).toContain("Nothing looks out of date");
  });

  it("does not claim an empty queue when the request failed", async () => {
    // An error rendered as "nothing is out of date" tells the user their brain
    // is healthy at exactly the moment it could not be checked.
    const ctx = load([new Error("offline")]);

    await ctx.loadStaleQueue();

    const html = ctx.__els.get("stale-list").innerHTML;
    expect(html).not.toContain("Nothing looks out of date");
    expect(html).toContain("Could not load");
  });
});
