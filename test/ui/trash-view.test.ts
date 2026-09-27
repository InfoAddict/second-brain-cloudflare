/**
 * The trash view (T-0101.2.2, TR-1).
 *
 * Trash lives at the Memories foot and in the menu's Data group, never as a
 * tab (Rahil's decision, 12-user-interaction-map.md section 8). Delete
 * forever lives here ONLY — the memory sheet's own button was removed by
 * SH-4, and this is the sole place it is still reachable. A teammate's GET
 * /trash is already pre-filtered server-side (BE-2, Q10); this view only has
 * to render what the Worker sends and explain that filtering in one line.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function makeEl(id?: string) {
  const classes = new Set<string>();
  const listeners = new Map<string, Set<(ev: any) => void>>();
  return {
    id,
    hidden: false,
    disabled: false,
    innerHTML: "",
    textContent: "",
    value: "",
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    dataset: {} as Record<string, string>,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    addEventListener(type: string, fn: (ev: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    dispatch(type: string, ev: any = {}) {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    },
  };
}

/** The trash sheet alone: rendering, paging, restore and the teammate note. */
function load(pages: any[] = [], opts: { teamMode?: boolean; teamIsAdmin?: boolean | null } = {}) {
  const els = new Map<string, any>();
  const toasts: { message: string; opts?: any }[] = [];
  const requests: { url: string; init: any }[] = [];
  const opened: unknown[] = [];
  let pageIndex = 0;
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    TEAM_MODE: opts.teamMode ?? false,
    teamIsAdmin: opts.teamIsAdmin ?? null,
    URLSearchParams,
    closeMenu: () => {},
    refreshAll: () => {},
    setTimeout: (fn: () => void) => fn(),
    clearTimeout: () => {},
    showToast: (message: string, o?: any) => toasts.push({ message, opts: o }),
    openView: (...args: unknown[]) => opened.push(args),
    fetch: async (url: string, init: any) => {
      requests.push({ url, init });
      const page = pages[Math.min(pageIndex++, pages.length - 1)] ?? { ok: true, items: [], next_cursor: null, retention_days: 14 };
      if (page instanceof Error) throw page;
      return { ok: page.ok !== false, status: page.status ?? 200, json: async () => page };
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
      body: { appendChild() {} },
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  // toast.js is deliberately not loaded: its real showToast (a top-level
  // function declaration) would shadow the ctx.showToast stub below, since
  // vm attaches `function` — unlike `let` — to the context object.
  for (const f of ["public/utils.js", "public/js/state.js", "public/js/confirm-sheet.js", "public/js/trash.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  ctx.__toasts = toasts;
  ctx.__requests = requests;
  ctx.__opened = opened;
  return ctx;
}

/** With the real memory-crud module, so Delete forever is the real caller, not a stub of it. */
function loadWithCrud(pages: any[] = []) {
  const els = new Map<string, any>();
  const toasts: { message: string; opts?: any }[] = [];
  const requests: { url: string; init: any }[] = [];
  let pageIndex = 0;
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    TEAM_MODE: false,
    teamIsAdmin: null,
    URLSearchParams,
    allEntries: [],
    closeMenu: () => {},
    refreshAll: () => {},
    setTimeout: (fn: () => void) => fn(),
    clearTimeout: () => {},
    showToast: (message: string, o?: any) => toasts.push({ message, opts: o }),
    notifyMemoryResolved: () => {},
    fetch: async (url: string, init: any) => {
      requests.push({ url, init });
      const page = pages[Math.min(pageIndex++, pages.length - 1)] ?? { ok: true, items: [], next_cursor: null, retention_days: 14 };
      return { ok: page.ok !== false, status: page.status ?? 200, json: async () => page };
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      querySelector: () => makeEl(),
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
      body: { appendChild() {} },
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of [
    "public/utils.js",
    "public/js/state.js",
    "public/js/confirm-sheet.js",
    "public/js/memory-crud.js",
    "public/js/trash.js",
  ]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  ctx.__toasts = toasts;
  ctx.__requests = requests;
  return ctx;
}

const el = (ctx: any, id: string) => ctx.document.getElementById(id);
/** trash.js declares its module state with `let`, so it lives in the vm
 * context's lexical scope, not as an enumerable property of it. */
const trashItemsOf = (ctx: any): any[] => vm.runInContext("trashItems", ctx);
/** Lets a fire-and-forget async call (loadMoreTrash, performTrashRestore)
 * finish its own chain of awaits before an assertion reads the result. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function item(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: "m1",
    preview: "First flagged claim",
    deleted_at: Date.UTC(2026, 8, 25, 12),
    days_left: 12,
    reason: "forget",
    channel: "rest",
    client: null,
    deleted_by_name: "Rahil",
    source: "notion",
    layer: "personal",
    can_restore: true,
    can_delete_forever: true,
    nonce: "n1",
    ...overrides,
  };
}

describe("both entry points open the sheet", () => {
  it("the Memories foot and the menu Data group both wire to openTrashSheet", () => {
    const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
    const footMatch = html.match(/id="mem-trash-link"[^>]*onclick="openTrashSheet\(\)"/);
    const menuMatch = html.match(/id="menu-trash-btn"[^>]*onclick="openTrashSheet\(\)"/);
    expect(footMatch, "Memories foot link calls openTrashSheet()").not.toBeNull();
    expect(menuMatch, "menu Data group button calls openTrashSheet()").not.toBeNull();
  });

  it("opening loads the first page and shows the sheet", async () => {
    const ctx = load([{ ok: true, items: [item()], next_cursor: null, retention_days: 14 }]);
    ctx.openTrashSheet();
    await flush();
    expect(el(ctx, "trash-sheet").classList.contains("open")).toBe(true);
    expect(ctx.__requests[0].url).toContain("/trash?");
  });
});

describe("rows render who, date and days left for each reason and channel", () => {
  it("a dashboard forget on a solo brain reads 'by you'", async () => {
    const ctx = load([{ ok: true, items: [item({ channel: "rest", client: null, deleted_by_name: "You" })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    expect(el(ctx, "trash-list").innerHTML).toContain("by you");
  });

  it("an MCP forget names the client", async () => {
    const ctx = load([{ ok: true, items: [item({ channel: "mcp", client: "Cursor" })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    expect(el(ctx, "trash-list").innerHTML).toContain("via Cursor");
  });

  it("an MCP forget with no client name falls back to 'an AI tool'", async () => {
    const ctx = load([{ ok: true, items: [item({ channel: "mcp", client: null })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    expect(el(ctx, "trash-list").innerHTML).toContain("via an AI tool");
  });

  it("a team brain names the person who forgot it", async () => {
    const ctx = load([{ ok: true, items: [item({ channel: "rest", deleted_by_name: "Ana" })], next_cursor: null, retention_days: 14 }], { teamMode: true });
    await ctx.loadTrashPage();
    expect(el(ctx, "trash-list").innerHTML).toContain("by Ana");
  });

  it("a mirror removal names the provider and does not claim a person forgot it", async () => {
    const ctx = load([{ ok: true, items: [item({ reason: "mirror", channel: null, client: null, source: "notion" })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    const html = el(ctx, "trash-list").innerHTML;
    expect(html).toContain("Removed");
    expect(html).toContain("Notion");
    expect(html).toContain("sync");
  });

  it("names the provider brand, not the raw source id, in every {provider} sentence", async () => {
    const ctx = load([{ ok: true, items: [item({ reason: "mirror", channel: null, client: null, source: "calendar-google" })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    const html = el(ctx, "trash-list").innerHTML;
    expect(html).toContain("Google Calendar");
    expect(html).not.toContain("calendar-google");
  });

  it("a disconnect removal says the integration was disconnected", async () => {
    const ctx = load([{ ok: true, items: [item({ reason: "disconnect", channel: null, client: null, source: "github" })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    const html = el(ctx, "trash-list").innerHTML;
    expect(html).toContain("GitHub");
    expect(html).toContain("disconnected");
  });

  it("shows the retention line reflecting a plural day count", async () => {
    const ctx = load([{ ok: true, items: [item({ days_left: 12 })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    expect(el(ctx, "trash-list").innerHTML).toContain("12 days");
  });

  it("uses the singular for exactly one day left", async () => {
    const ctx = load([{ ok: true, items: [item({ days_left: 1 })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    const html = el(ctx, "trash-list").innerHTML;
    expect(html).toContain("1 day");
    expect(html).not.toContain("1 days");
  });
});

describe("honors can_restore and can_delete_forever per row (contract 4.3)", () => {
  it("hides Delete forever on a row the reader may not permanently delete", async () => {
    const ctx = load([{ ok: true, items: [item({ can_restore: true, can_delete_forever: false })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    const html = el(ctx, "trash-list").innerHTML;
    expect(html).toContain('data-action="restore"');
    expect(html).not.toContain('data-action="delete-forever"');
  });

  it("hides Restore on a row the reader may not restore", async () => {
    const ctx = load([{ ok: true, items: [item({ can_restore: false, can_delete_forever: true })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    const html = el(ctx, "trash-list").innerHTML;
    expect(html).not.toContain('data-action="restore"');
    expect(html).toContain('data-action="delete-forever"');
  });

  it("shows neither action when both are false", async () => {
    const ctx = load([{ ok: true, items: [item({ can_restore: false, can_delete_forever: false })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    const html = el(ctx, "trash-list").innerHTML;
    expect(html).not.toContain('data-action="restore"');
    expect(html).not.toContain('data-action="delete-forever"');
  });
});

describe("days 0 reads waiting for a daily cleanup", () => {
  it("a row past retention but not yet purged says it is waiting for a cleanup, not 'the next' one", async () => {
    // A single night's cleanup is capped, so a backlog can leave a day-0 row
    // waiting past the very next run — "waiting" is the copy deck's honest
    // fix for the earlier "at the next cleanup" claim.
    const ctx = load([{ ok: true, items: [item({ days_left: 0 })], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    expect(el(ctx, "trash-list").innerHTML).toContain("Waiting to be removed for good at a daily cleanup");
  });
});

describe("Restore posts /restore, removes the row and offers Open", () => {
  it("restoring a plain forget posts immediately and removes the row", async () => {
    const ctx = load([
      { ok: true, items: [item({ id: "m1" }), item({ id: "m2", preview: "Second" })], next_cursor: null, retention_days: 14 },
      { ok: true },
    ]);
    await ctx.loadTrashPage();
    ctx.handleTrashRestore(trashItemsOf(ctx).find((i: any) => i.id === "m1"));
    await flush();

    const restoreCall = ctx.__requests.find((r: any) => r.url.endsWith("/restore"));
    expect(restoreCall, "/restore was called").toBeTruthy();
    expect(JSON.parse(restoreCall.init.body)).toEqual({ id: "m1", nonce: "n1" });

    const html = el(ctx, "trash-list").innerHTML;
    expect(html).not.toContain("First flagged claim");
    expect(html).toContain("Second");

    expect(ctx.__toasts).toHaveLength(1);
    expect(ctx.__toasts[0].message).toBe("Restored");
    await ctx.__toasts[0].opts.onAction();
    expect(ctx.__opened).toHaveLength(1);
  });

  it("sends the row's nonce with /restore", async () => {
    const ctx = load([
      { ok: true, items: [item({ id: "m1", nonce: "abc123" })], next_cursor: null, retention_days: 14 },
      { ok: true },
    ]);
    await ctx.loadTrashPage();
    ctx.handleTrashRestore(trashItemsOf(ctx)[0]);
    await flush();
    const restoreCall = ctx.__requests.find((r: any) => r.url.endsWith("/restore"));
    expect(JSON.parse(restoreCall.init.body)).toEqual({ id: "m1", nonce: "abc123" });
  });

  it("a 404 (stale nonce: the row is gone) refreshes the list and shows the conflict message", async () => {
    const ctx = load([
      { ok: true, items: [item({ id: "m1" })], next_cursor: null, retention_days: 14 },
      { ok: false, status: 404, error: "not_found" },
      { ok: true, items: [], next_cursor: null, retention_days: 14 },
    ]);
    await ctx.loadTrashPage();
    ctx.handleTrashRestore(trashItemsOf(ctx)[0]);
    await flush();
    expect(ctx.__toasts[0].message).toBe("This memory is already back, restored from another tab or by an AI tool.");
    // The refresh landed: the list now reflects the server's current state.
    expect(ctx.__requests.filter((r: any) => r.url.includes("/trash?")).length).toBe(2);
    expect(el(ctx, "trash-list").innerHTML).toContain("The trash is empty.");
  });

  it("a 409 (stale nonce: someone else already acted) refreshes the list and shows the conflict message", async () => {
    const ctx = load([
      { ok: true, items: [item({ id: "m1" })], next_cursor: null, retention_days: 14 },
      { ok: false, status: 409, error: "conflict" },
      { ok: true, items: [], next_cursor: null, retention_days: 14 },
    ]);
    await ctx.loadTrashPage();
    ctx.handleTrashRestore(trashItemsOf(ctx)[0]);
    await flush();
    expect(ctx.__toasts[0].message).toBe("This memory is already back, restored from another tab or by an AI tool.");
    expect(ctx.__requests.filter((r: any) => r.url.includes("/trash?")).length).toBe(2);
  });

  it("maps a 502 to the re-index message", async () => {
    const ctx = load([
      { ok: true, items: [item({ id: "m1" })], next_cursor: null, retention_days: 14 },
      { ok: false, status: 502, error: "reembed_failed" },
    ]);
    await ctx.loadTrashPage();
    ctx.handleTrashRestore(trashItemsOf(ctx)[0]);
    await flush();
    expect(ctx.__toasts[0].message).toBe("Could not restore: search did not update. Nothing changed. Try again.");
  });
});

describe("mirror restore confirms first", () => {
  it("a mirror row asks before restoring, and only restores on accept", async () => {
    const ctx = load([
      { ok: true, items: [item({ id: "m1", reason: "mirror", source: "notion" })], next_cursor: null, retention_days: 14 },
      { ok: true },
    ]);
    await ctx.loadTrashPage();
    ctx.handleTrashRestore(trashItemsOf(ctx)[0]);

    // Not called yet: the confirm sheet is up, not the request.
    expect(ctx.__requests.some((r: any) => r.url.endsWith("/restore"))).toBe(false);
    expect(el(ctx, "confirm-title").textContent).toBe("Restore this memory?");
    expect(el(ctx, "confirm-body").textContent).toContain("Notion");

    await ctx.runConfirmAction();
    const restoreCall = ctx.__requests.find((r: any) => r.url.endsWith("/restore"));
    expect(restoreCall).toBeTruthy();
  });

  it("a plain forget never asks first", async () => {
    const ctx = load([{ ok: true, items: [item({ id: "m1", reason: "forget" })], next_cursor: null, retention_days: 14 }, { ok: true }]);
    await ctx.loadTrashPage();
    ctx.handleTrashRestore(trashItemsOf(ctx)[0]);
    await flush();
    expect(ctx.__requests.some((r: any) => r.url.endsWith("/restore"))).toBe(true);
  });
});

describe("Delete forever uses the existing confirm and removes the row", () => {
  it("goes through openDeleteForeverConfirm, sends the row's nonce, and removes the row on success", async () => {
    const ctx = loadWithCrud([
      { ok: true, items: [item({ id: "m1", nonce: "abc123" }), item({ id: "m2", preview: "Second" })], next_cursor: null, retention_days: 14 },
      { ok: true },
    ]);
    await ctx.loadTrashPage();

    ctx.handleTrashDeleteForever(trashItemsOf(ctx).find((i: any) => i.id === "m1"));
    expect(el(ctx, "confirm-title").textContent).toBe("Delete this memory for good?");
    await ctx.runConfirmAction();

    const forgetCall = ctx.__requests.find((r: any) => r.url.endsWith("/forget"));
    expect(JSON.parse(forgetCall.init.body)).toEqual({ id: "m1", permanent: true, confirm: "m1", nonce: "abc123" });

    const html = el(ctx, "trash-list").innerHTML;
    expect(html).not.toContain("First flagged claim");
    expect(html).toContain("Second");
  });

  it("a 404 or 409 (stale nonce) refreshes the list and shows the conflict message instead of a generic failure", async () => {
    const ctx = loadWithCrud([
      { ok: true, items: [item({ id: "m1" })], next_cursor: null, retention_days: 14 },
      { ok: false, status: 409, error: "conflict" },
      { ok: true, items: [], next_cursor: null, retention_days: 14 },
    ]);
    await ctx.loadTrashPage();

    ctx.handleTrashDeleteForever(trashItemsOf(ctx)[0]);
    await ctx.runConfirmAction();
    await flush();

    expect(ctx.__toasts[0].message).toBe("This memory is already back, restored from another tab or by an AI tool.");
    expect(ctx.__requests.filter((r: any) => r.url.includes("/trash?")).length).toBe(2);
  });
});

describe("paging appends and hides Show more at the end", () => {
  it("Show more appends the next page and hides once next_cursor is null", async () => {
    const ctx = load([
      { ok: true, items: [item({ id: "m1" })], next_cursor: "123:m1", retention_days: 14 },
      { ok: true, items: [item({ id: "m2", preview: "Second" })], next_cursor: null, retention_days: 14 },
    ]);
    await ctx.loadTrashPage();
    expect(el(ctx, "trash-more").hidden).toBe(false);

    ctx.loadMoreTrash(el(ctx, "trash-more"));
    await flush();

    const html = el(ctx, "trash-list").innerHTML;
    expect(html).toContain("First flagged claim");
    expect(html).toContain("Second");
    expect(el(ctx, "trash-more").hidden).toBe(true);
  });
});

describe("escapes client and preview", () => {
  it("never renders a raw tag from the preview or the client name", async () => {
    const ctx = load([
      {
        ok: true,
        items: [item({ id: "m1", preview: '<img src=x onerror=alert(1)>', channel: "mcp", client: "<script>" })],
        next_cursor: null,
        retention_days: 14,
      },
    ]);
    await ctx.loadTrashPage();
    const html = el(ctx, "trash-list").innerHTML;
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("empty state", () => {
  it("says the trash is empty rather than nothing", async () => {
    const ctx = load([{ ok: true, items: [], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    expect(el(ctx, "trash-list").innerHTML).toContain("The trash is empty.");
  });

  it("shows a note explaining a teammate sees only what they can restore", async () => {
    const ctx = load([{ ok: true, items: [], next_cursor: null, retention_days: 14 }], { teamMode: true, teamIsAdmin: false });
    await ctx.loadTrashPage();
    expect(el(ctx, "trash-teammate-note").hidden).toBe(false);
    expect(el(ctx, "trash-teammate-note").textContent).toContain("you can restore");
  });

  it("does not show the teammate note on a solo brain", async () => {
    const ctx = load([{ ok: true, items: [], next_cursor: null, retention_days: 14 }]);
    await ctx.loadTrashPage();
    expect(el(ctx, "trash-teammate-note").hidden).toBe(true);
  });
});

describe("both locales", () => {
  it("speaks Italian when the page does", async () => {
    const ctx = load([{ ok: true, items: [item({ channel: "rest", deleted_by_name: "You" })], next_cursor: null, retention_days: 14 }]);
    ctx.initI18n("it");
    await ctx.loadTrashPage();
    const html = el(ctx, "trash-list").innerHTML;
    expect(html).toContain("da te");
  });

  it("translates the empty state and the Restore/Delete forever labels", async () => {
    const ctx = load([{ ok: true, items: [item({ id: "m1" })], next_cursor: null, retention_days: 14 }]);
    ctx.initI18n("it");
    await ctx.loadTrashPage();
    const html = el(ctx, "trash-list").innerHTML;
    expect(html).toContain("Ripristina");
    expect(html).toContain("Elimina per sempre");
  });
});

/**
 * Restore and Delete forever must stay a normal button height at every
 * width, including a Restore-only row. There is no browser in this test
 * runner to lay flex out and measure it, so this reads the rule as text
 * (the same technique test/unit/history-trash-settings-parity.test.ts uses
 * for a Rust file) - a stacked layout, or a container that stretches its
 * children, is how a lone button balloons to fill the tallest sibling.
 */
describe("the action row keeps a normal button height at every width", () => {
  const css = readFileSync(resolve(ROOT, "public/css/trash.css"), "utf8");

  it("no stacking rule remains for .trash-item-actions", () => {
    expect(css).not.toMatch(/\.trash-item-actions\s*{[^}]*flex-direction:\s*column/s);
    expect(css).not.toContain("flex-direction: column");
  });

  it(".trash-btn has a fixed height under 48px, not just a minimum", () => {
    const rule = css.match(/\.trash-btn\s*{([^}]*)}/s)?.[1] ?? "";
    expect(rule).not.toContain("min-height");
    const height = Number(rule.match(/(?:^|\s)height:\s*(\d+)px/)?.[1]);
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThan(48);
  });

  it(".trash-item-actions holds two equal tracks, so a lone button lands half-width, not full-width", () => {
    const rule = css.match(/\.trash-item-actions\s*{([^}]*)}/s)?.[1] ?? "";
    expect(rule).toMatch(/display:\s*grid/);
    expect(rule).toMatch(/grid-template-columns:\s*1fr 1fr/);
  });

  it(".trash-item-actions does not stretch its children to the tallest one", () => {
    const rule = css.match(/\.trash-item-actions\s*{([^}]*)}/s)?.[1] ?? "";
    expect(rule).toMatch(/align-items:\s*start/);
  });
});
