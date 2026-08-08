/**
 * Getting fresh data back after a mutation.
 *
 * This dashboard is also the desktop app's UI, running in a Tauri window with
 * no address bar and no reload. Anything the app does not refetch itself stays
 * wrong on screen until the user quits — which is how a deleted memory left the
 * header reading 1,881 and the greeting reading 1,880, from two different
 * endpoints, with no way for the user to resolve the disagreement.
 *
 * So the thing under test is coverage: refreshing has to reach every source the
 * shell reads from, not just the ones a given screen happens to know about.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function load() {
  const calls: string[] = [];
  const listeners = new Map<string, (e?: unknown) => void>();
  const btn = {
    classList: {
      _s: new Set<string>(),
      add(c: string) { this._s.add(c); },
      remove(c: string) { this._s.delete(c); },
      contains(c: string) { return this._s.has(c); },
    },
  };
  const menuSheet = {
    classList: {
      _s: new Set<string>(),
      add(c: string) { this._s.add(c); },
      remove(c: string) { this._s.delete(c); },
      contains(c: string) { return this._s.has(c); },
    },
  };
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    Date,
    Promise,
    calls,
    listeners,
    btn,
    // Each of the four sources the shell reads from, recorded as it is called.
    updateStatus: () => { calls.push("count"); return Promise.resolve(); },
    loadBrief: () => { calls.push("brief"); return Promise.resolve(); },
    loadTags: () => { calls.push("tags"); return Promise.resolve(); },
    loadRecent: () => { calls.push("list"); return Promise.resolve(); },
    loadMenuStats: () => { calls.push("stats"); return Promise.resolve(); },
    document: {
      visibilityState: "visible",
      querySelectorAll: (sel: string) => (sel === ".refresh-now" ? [btn] : []),
      getElementById: (id: string) => (id === "menu-sheet" ? menuSheet : null),
      addEventListener: (ev: string, fn: any) => listeners.set(ev, fn),
    },
    menuSheet,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/refresh.js"), "utf8"), ctx);
  return ctx;
}

describe("refreshAll", () => {
  it("refetches the brief, not just the count", async () => {
    // The whole bug in one assertion: the header count was refreshed after a
    // delete and the brief was not, so the greeting kept the old total.
    const ctx = load();
    await ctx.refreshAll();
    expect(ctx.calls.sort()).toEqual(["brief", "count", "list", "tags"]);
  });

  it("leaves the list alone when the caller has already updated it", async () => {
    // Deleting animates the row out and drops it from allEntries locally;
    // reloading the list here would replace the element mid-animation.
    const ctx = load();
    await ctx.refreshAll({ list: false });
    expect(ctx.calls).not.toContain("list");
    expect(ctx.calls.sort()).toEqual(["brief", "count", "tags"]);
  });

  it("does nothing before the user has connected", async () => {
    const ctx = load();
    ctx.WORKER_URL = "";
    await ctx.refreshAll();
    expect(ctx.calls).toEqual([]);
  });

  it("collapses overlapping refreshes into one round trip", async () => {
    // Two captures in quick succession, or a mutation landing while the
    // visibility refresh is still in flight.
    const ctx = load();
    const both = Promise.all([ctx.refreshAll(), ctx.refreshAll()]);
    await both;
    expect(ctx.calls).toHaveLength(4);
  });

  it("still refreshes after an endpoint fails, rather than giving up partway", async () => {
    const ctx = load();
    ctx.loadBrief = () => { ctx.calls.push("brief"); return Promise.reject(new Error("down")); };
    await expect(ctx.refreshAll()).resolves.toBeUndefined();
    expect(ctx.calls.sort()).toEqual(["brief", "count", "list", "tags"]);
  });

  it("refreshes the settings numbers only while that sheet is open", async () => {
    const ctx = load();
    await ctx.refreshAll();
    expect(ctx.calls).not.toContain("stats");

    ctx.calls.length = 0;
    ctx.menuSheet.classList.add("open");
    await ctx.refreshAll();
    expect(ctx.calls).toContain("stats");
  });

  it("spins whichever refresh control is on screen and stops when done", async () => {
    const ctx = load();
    const p = ctx.refreshAll();
    expect(ctx.btn.classList.contains("spinning")).toBe(true);
    await p;
    expect(ctx.btn.classList.contains("spinning")).toBe(false);
  });
});

describe("refreshIfStale", () => {
  it("trusts a screen that was just refreshed", async () => {
    const ctx = load();
    await ctx.refreshAll();
    ctx.calls.length = 0;
    ctx.refreshIfStale();
    expect(ctx.calls).toEqual([]);
  });

  it("refetches once what is on screen has had time to go stale", async () => {
    const ctx = load();
    await ctx.refreshAll();
    ctx.calls.length = 0;
    // A window left open overnight, or a tab returned to an hour later.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    try {
      ctx.refreshIfStale();
      expect(ctx.calls).toContain("brief");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("never blocks an explicit press or a mutation", async () => {
    // The interval exists to stop tab-flicking from re-running the brief's six
    // D1 queries; it must not swallow a refresh the user asked for.
    const ctx = load();
    await ctx.refreshAll();
    ctx.calls.length = 0;
    await ctx.refreshAll();
    expect(ctx.calls).toHaveLength(4);
  });
});

describe("returning to a window that has been sitting", () => {
  it("re-reads on becoming visible again", async () => {
    const ctx = load();
    const onVisibility = ctx.listeners.get("visibilitychange");
    expect(onVisibility).toBeTypeOf("function");

    onVisibility!();
    expect(ctx.calls).toContain("brief");

    // Going away is not a reason to fetch anything.
    ctx.calls.length = 0;
    ctx.document.visibilityState = "hidden";
    onVisibility!();
    expect(ctx.calls).toEqual([]);
  });
});
