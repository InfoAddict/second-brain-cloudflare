/**
 * The brain-version what's-new line (T-0101.8.4, TR-3).
 *
 * Dismissible, shown for 14 days from history_since, to everyone — owners
 * and teammates alike (Q8). There is no static container for it in
 * index.html (this lane's regions are the Memories foot, the menu groups and
 * the two new sheets), so it builds and inserts its own element; this fake
 * DOM tracks that insertion by registering any node it is given an id
 * through appendChild/insertBefore, the same way a real document's
 * getElementById would find it once attached.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");
const DAY = 24 * 60 * 60 * 1000;

function makeEl(id?: string) {
  const classes = new Set<string>();
  const el: any = {
    id,
    hidden: false,
    innerHTML: "",
    className: "",
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    setAttribute() {},
    appendChild(child: any) {
      register(child);
      return child;
    },
    insertBefore(child: any, _ref: any) {
      register(child);
      return child;
    },
    parentNode: null as any,
  };
  return el;
}

const els = new Map<string, any>();
function register(node: any) {
  if (node && node.id) els.set(node.id, node);
}

function load(localStorageSeed: Record<string, string> = {}) {
  els.clear();
  const store = new Map<string, string>(Object.entries(localStorageSeed));
  const boardTiles = makeEl("board-tiles");
  const boardTilesParent = makeEl();
  boardTiles.parentNode = boardTilesParent;
  els.set("board-tiles", boardTiles);
  const body = makeEl();

  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
    },
    readTeamConfig: async () => ({ config: { TRASH_RETENTION_DAYS: 14 } }),
    document: {
      getElementById: (id: string) => els.get(id) ?? null,
      createElement: () => makeEl(),
      body,
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/trash.js", "public/js/whats-new.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  ctx.__store = store;
  return ctx;
}

const line = (ctx: any) => ctx.document.getElementById("whats-new-line");

describe("hidden on a 3.x brain", () => {
  it("a Worker version below major 4 shows nothing", async () => {
    const ctx = load();
    await ctx.renderWhatsNewLine({ version: "3.7.2", history_since: Date.now() });
    expect(line(ctx)).toBeNull();
  });

  it("no health body at all shows nothing", async () => {
    const ctx = load();
    await ctx.renderWhatsNewLine(undefined);
    expect(line(ctx)).toBeNull();
  });
});

describe("shown on 4.x within 14 days of history_since", () => {
  it("renders the line when the brain turned 4.0 five days ago", async () => {
    const ctx = load();
    await ctx.renderWhatsNewLine({ version: "4.0.0", history_since: Date.now() - 5 * DAY });
    expect(line(ctx)).not.toBeNull();
    expect(line(ctx).hidden).toBe(false);
    expect(line(ctx).innerHTML).toContain("New in 4.0");
  });

  it("the link opens the trash", async () => {
    const ctx = load();
    await ctx.renderWhatsNewLine({ version: "4.0.0", history_since: Date.now() - 5 * DAY });
    expect(line(ctx).innerHTML).toContain('onclick="openTrashSheet()"');
  });
});

describe("hidden after 14 days", () => {
  it("a brain that turned 4.0 fifteen days ago shows nothing", async () => {
    const ctx = load();
    await ctx.renderWhatsNewLine({ version: "4.0.0", history_since: Date.now() - 15 * DAY });
    expect(line(ctx)?.hidden ?? true).toBe(true);
  });
});

describe("first-seen fallback without history_since", () => {
  it("starts its own 14-day clock the first time it renders", async () => {
    const ctx = load();
    await ctx.renderWhatsNewLine({ version: "4.0.0" });
    expect(line(ctx)).not.toBeNull();
    expect(line(ctx).hidden).toBe(false);
    expect(ctx.__store.get("sb-whats-new-4-first-seen")).toBeTruthy();
  });

  it("hides once this browser's own first-seen marker is 14 days old", async () => {
    const ctx = load({ "sb-whats-new-4-first-seen": String(Date.now() - 15 * DAY) });
    await ctx.renderWhatsNewLine({ version: "4.0.0" });
    expect(line(ctx)?.hidden ?? true).toBe(true);
  });
});

describe("dismiss persists", () => {
  it("dismissing hides it and a later render (a reload) never shows it again", async () => {
    const ctx = load();
    await ctx.renderWhatsNewLine({ version: "4.0.0", history_since: Date.now() - 5 * DAY });
    expect(line(ctx).hidden).toBe(false);

    ctx.dismissWhatsNew();
    expect(line(ctx).hidden).toBe(true);
    expect(ctx.__store.get("sb-whats-new-4")).toBe("1");

    // A fresh render pass, as a reload would do, with the dismissal already
    // in storage from before.
    const ctx2 = load({ "sb-whats-new-4": "1" });
    await ctx2.renderWhatsNewLine({ version: "4.0.0", history_since: Date.now() - 5 * DAY });
    expect(line(ctx2)?.hidden ?? true).toBe(true);
  });
});

describe("n follows TRASH_RETENTION_DAYS", () => {
  it("the line's day count reads the Worker's configured retention", async () => {
    const ctx = load();
    ctx.readTeamConfig = async () => ({ config: { TRASH_RETENTION_DAYS: 30 } });
    await ctx.renderWhatsNewLine({ version: "4.0.0", history_since: Date.now() - 5 * DAY });
    expect(line(ctx).innerHTML).toContain("30 days");
  });

  it("falls back to 14 when the config read fails", async () => {
    const ctx = load();
    ctx.readTeamConfig = async () => {
      throw new Error("offline");
    };
    await ctx.renderWhatsNewLine({ version: "4.0.0", history_since: Date.now() - 5 * DAY });
    expect(line(ctx).innerHTML).toContain("14 days");
  });
});

describe("both locales", () => {
  it("speaks Italian when the page does", async () => {
    const ctx = load();
    ctx.initI18n("it");
    await ctx.renderWhatsNewLine({ version: "4.0.0", history_since: Date.now() - 5 * DAY });
    expect(line(ctx).innerHTML).toContain("Novità della 4.0");
    expect(line(ctx).innerHTML).toContain("Vai al cestino");
  });
});
