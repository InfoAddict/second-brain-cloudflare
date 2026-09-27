/**
 * SH-1: the history timeline (renderHistory) that replaces the plain event
 * list on a Worker that sends `history` (contract 4.1 of the v4 UX spec).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function makeEl() {
  const classes = new Set<string>();
  const el: any = {
    id: "",
    disabled: false,
    textContent: "",
    innerHTML: "",
    className: "",
    onclick: null,
    style: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      toggle(c: string, on?: boolean) {
        if (on ?? !classes.has(c)) classes.add(c);
        else classes.delete(c);
      },
      contains: (c: string) => classes.has(c),
    },
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
    appendChild() {},
    remove() {},
    focus() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return el;
}

/**
 * A fake `.history-item` row, wired the way renderHistory's real markup would
 * be: `dataset.seq` for the data-seq join key, and `querySelector` handing
 * back the fixed set of child controls a change row can have. Exactly the
 * pattern detail-and-receipts.test.ts's `relatedContainer()` uses for
 * loadRelated — the production code joins by dataset, not DOM position, so
 * the stub does not need to come from parsing the innerHTML string.
 */
function makeHistoryLi(item: any) {
  const before = makeEl();
  before.dataset.preview = item.before_preview || "";
  before.textContent = item.before_preview || "";
  const showBtn = makeEl();
  showBtn.dataset.action = "show-before";
  showBtn.textContent = "Show all";
  const undoBtn = item.can_undo ? makeEl() : null;
  if (undoBtn) {
    undoBtn.dataset.action = "undo";
    undoBtn.textContent = "Undo";
  }
  const restoreBtn = item.can_restore ? makeEl() : null;
  if (restoreBtn) {
    restoreBtn.dataset.action = "restore-version";
    restoreBtn.textContent = "Restore this version";
  }
  const li = makeEl();
  li.dataset.seq = String(item.seq);
  li.querySelector = (sel: string) => {
    if (sel === ".history-before-text") return before;
    if (sel === '[data-action="show-before"]') return showBtn;
    if (sel === '[data-action="undo"]') return undoBtn;
    if (sel === '[data-action="restore-version"]') return restoreBtn;
    return null;
  };
  return li;
}

function load(fetchImpl?: (url: string, init?: any) => Promise<any>) {
  const els = new Map<string, any>();
  const calls: Array<{ url: string; init?: any }> = [];
  const ctx: any = {
    console,
    calls,
    confirm: () => {
      throw new Error("confirm() must not be used");
    },
    alert: () => {
      throw new Error("alert() must not be used");
    },
    setTimeout: (fn: () => void) => fn(),
    clearTimeout: () => {},
    refreshAll: () => {},
    fetch: (url: string, init?: any) => {
      calls.push({ url, init });
      if (fetchImpl) return fetchImpl(url, init);
      return Promise.reject(new Error("no network in this test"));
    },
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
  };
  ctx.document = {
    getElementById: (id: string) => {
      if (!els.has(id)) {
        const el = makeEl();
        el.id = id;
        els.set(id, el);
      }
      return els.get(id);
    },
    createElement: () => makeEl(),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    body: {
      style: {},
      appendChild(el: any) {
        if (el.id) els.set(el.id, el);
      },
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/toast.js", "public/js/confirm-sheet.js", "public/js/undo.js", "public/js/history-view.js", "public/js/memory-crud.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  ctx.__calls = calls;
  return ctx;
}

/**
 * Wires `#view-timeline`'s querySelectorAll to hand back one stub row per
 * change item, renders, and returns both the raw element (for innerHTML
 * content checks) and the stub rows (for wiring checks).
 */
function renderAndWire(ctx: any, entry: any) {
  const tl = ctx.document.getElementById("view-timeline");
  const changeItems = (entry.history?.items || []).filter((it: any) => it.kind === "change");
  const liStubs = changeItems.map(makeHistoryLi);
  tl.querySelectorAll = (sel: string) => (sel === ".history-item" ? liStubs : []);
  ctx.renderHistory(entry);
  return { tl, liStubs };
}

const CHANGE_NEWEST = {
  kind: "change",
  seq: 7,
  at: 1790000000000,
  reason: "update",
  channel: "mcp",
  client: "Claude",
  actor_name: "Rahil",
  before_preview: "Uses Postgres 15 for the analytics stack, chosen for JSON support.",
  before_status: "canonical",
  can_undo: true,
  can_restore: false,
};

const CHANGE_OLDER = {
  kind: "change",
  seq: 6,
  at: 1789000000000,
  reason: "append",
  channel: "rest",
  client: null,
  actor_name: "Rahil",
  before_preview: "Older text before the append.",
  before_status: "canonical",
  can_undo: false,
  can_restore: true,
};

const EVENT_SHARED = {
  kind: "event",
  event: "shared",
  at: 1788000000000,
  channel: "rest",
  client: null,
  actor_name: "Ana",
};

describe("renderHistory — change and event rows", () => {
  it("renders change rows newest first with reason, who and before preview", () => {
    const ctx = load();
    const { tl } = renderAndWire(ctx, { id: "e1", history: { items: [CHANGE_NEWEST, CHANGE_OLDER, EVENT_SHARED] } });
    const html = tl.innerHTML as string;
    const editedAt = html.indexOf("Edited");
    const addedAt = html.indexOf("Added to");
    const sharedAt = html.indexOf("Ana");
    expect(editedAt).toBeGreaterThanOrEqual(0);
    expect(addedAt).toBeGreaterThan(editedAt); // newest first
    expect(sharedAt).toBeGreaterThan(addedAt);
    expect(html).toContain("Rahil");
    expect(html).toContain("Claude");
    expect(html).toContain("Uses Postgres 15");
  });

  it("Undo shows only when can_undo; Restore this version only when can_restore", () => {
    const ctx = load();
    const { tl } = renderAndWire(ctx, { id: "e1", history: { items: [CHANGE_NEWEST, CHANGE_OLDER] } });
    const html = tl.innerHTML as string;
    expect(html).toContain('data-action="undo"');
    expect(html).toContain('data-action="restore-version"');
    // The newest row's undo appears before the older row's restore.
    expect(html.indexOf('data-action="undo"')).toBeLessThan(html.indexOf('data-action="restore-version"'));
  });

  it("falls back to today's timeline when history is absent", () => {
    const ctx = load();
    ctx.renderViewTimeline({ timeline: [{ event: "created", actor_name: "Bob", created_at: 1 }] });
    const html = ctx.__els.get("view-timeline").innerHTML as string;
    expect(html).toContain("Captured");
    expect(html).not.toContain("history-list");
  });

  // UI review fix: renderHistory used to hide #view-timeline whenever
  // entry.history.items was empty, before it looked at can_edit, which
  // silently dropped the lock note for a shared memory with rich history that
  // nobody has edited yet — the fallback timeline already guards this case.
  it("shows the lock note alone when history is empty and the memory is locked", () => {
    const ctx = load();
    const { tl } = renderAndWire(ctx, { id: "e1", can_edit: false, actor_name: "Bob", history: { items: [] } });
    expect(tl.style.display).toBe("");
    expect(tl.innerHTML).toContain("Shared by Bob. Only they can edit or forget it.");
    expect(tl.innerHTML).not.toContain("history-list");
  });

  it("shows the lock note after a real history list too, on a locked memory", () => {
    const ctx = load();
    const { tl } = renderAndWire(ctx, { id: "e1", can_edit: false, actor_name: "Bob", history: { items: [CHANGE_NEWEST] } });
    expect(tl.innerHTML).toContain("history-list");
    expect(tl.innerHTML).toContain("Shared by Bob. Only they can edit or forget it.");
  });

  it("hides history entirely when empty and not locked", () => {
    const ctx = load();
    const { tl } = renderAndWire(ctx, { id: "e1", history: { items: [] } });
    expect(tl.style.display).toBe("none");
    expect(tl.innerHTML).toBe("");
  });

  it("client name is escaped", () => {
    const ctx = load();
    const evil = { ...CHANGE_NEWEST, client: "<img src=x>" };
    const { tl } = renderAndWire(ctx, { id: "e1", history: { items: [evil] } });
    expect(tl.innerHTML).not.toContain("<img");
    expect(tl.innerHTML).toContain("&lt;img");
  });

  it("every history string exists in both locales", () => {
    const ctx = load();
    const en = vm.runInContext("I18N_EN", ctx).history;
    const it = vm.runInContext("I18N_IT", ctx).history;
    expect(Object.keys(en).sort()).toEqual(Object.keys(it).sort());
    for (const key of Object.keys(en)) {
      expect(it[key], key).toBeTruthy();
    }
  });
});

describe("renderHistory — footers", () => {
  it("each footer renders only when set", () => {
    const ctx = load();
    const { tl: tlNone } = renderAndWire(ctx, { id: "e1", history: { items: [CHANGE_NEWEST], footer: {} } });
    expect(tlNone.innerHTML).not.toContain("history-footer");

    const { tl: tlPruned } = renderAndWire(ctx, { id: "e1", history: { items: [CHANGE_NEWEST], footer: { pruned: true, kept: 20 } } });
    expect(tlPruned.innerHTML).toContain('data-footer="pruned"');
    expect(tlPruned.innerHTML).toContain("20");
    expect(tlPruned.innerHTML).not.toContain('data-footer="not-recorded"');

    const { tl: tlNotRecorded } = renderAndWire(ctx, {
      id: "e1",
      history: { items: [CHANGE_NEWEST], footer: { not_recorded_before: 1700000000000 } },
    });
    expect(tlNotRecorded.innerHTML).toContain('data-footer="not-recorded"');

    const { tl: tlShared } = renderAndWire(ctx, {
      id: "e1",
      history: { items: [CHANGE_NEWEST], footer: { shared_cut_by: "Ana" } },
    });
    expect(tlShared.innerHTML).toContain('data-footer="shared-cut"');
    expect(tlShared.innerHTML).toContain("Ana");
  });
});

describe("renderHistory — Show all", () => {
  it("fetches /entry/version once and toggles", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/entry/version?id=e1&seq=6");
      return { json: async () => ({ ok: true, id: "e1", seq: 6, content: "The full text before change 6, much longer than the preview." }) };
    });
    const ctx = load(fetchImpl);
    const { liStubs } = renderAndWire(ctx, { id: "e1", history: { items: [CHANGE_OLDER] } });
    const showBtn = liStubs[0].querySelector('[data-action="show-before"]');
    await showBtn.onclick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(liStubs[0].querySelector(".history-before-text").textContent).toContain("much longer than the preview");
    expect(showBtn.textContent).toBe("Show less");

    await showBtn.onclick();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // collapsing does not refetch
    expect(liStubs[0].querySelector(".history-before-text").textContent).toBe(CHANGE_OLDER.before_preview);
    expect(showBtn.textContent).toBe("Show all");

    await showBtn.onclick();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // expanding again reuses the cached text
  });
});

describe("renderHistory — Undo and Restore actions", () => {
  it("Undo posts /undo and re-hydrates", async () => {
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.includes("/undo")) {
        expect(JSON.parse(init.body)).toEqual({ id: "e1" });
        return { ok: true, status: 200, json: async () => ({ ok: true, id: "e1", status: "reverted" }) };
      }
      if (url.includes("/entry?id=")) {
        return { ok: true, json: async () => ({ ok: true, entry: { id: "e1", history: { items: [] } } }) };
      }
      throw new Error("unexpected url " + url);
    });
    const ctx = load(fetchImpl);
    ctx.viewOpenId = "e1";
    const { liStubs } = renderAndWire(ctx, { id: "e1", history: { items: [CHANGE_NEWEST] } });
    const undoBtn = liStubs[0].querySelector('[data-action="undo"]');
    await undoBtn.onclick();
    expect(ctx.__calls.some((c: any) => c.url.includes("/undo"))).toBe(true);
    expect(ctx.__calls.some((c: any) => c.url.includes("/entry?id=e1"))).toBe(true);
  });

  it("Restore opens a primary confirm with the date and posts to_version", async () => {
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.includes("/undo")) {
        expect(JSON.parse(init.body)).toEqual({ id: "e1", to_version: 6 });
        return { ok: true, status: 200, json: async () => ({ ok: true, id: "e1", status: "restored" }) };
      }
      if (url.includes("/entry?id=")) {
        return { ok: true, json: async () => ({ ok: true, entry: { id: "e1", history: { items: [] } } }) };
      }
      throw new Error("unexpected url " + url);
    });
    const ctx = load(fetchImpl);
    ctx.viewOpenId = "e1";
    const { liStubs } = renderAndWire(ctx, { id: "e1", history: { items: [CHANGE_OLDER] } });
    const restoreBtn = liStubs[0].querySelector('[data-action="restore-version"]');
    restoreBtn.onclick();
    expect(ctx.__els.get("confirm-title").textContent).toBe("Restore this version?");
    expect(ctx.__els.get("confirm-body").textContent).toContain("goes back to how it was before");
    expect(ctx.__els.get("confirm-accept-btn").className).toContain("btn-primary");
    await ctx.runConfirmAction();
    expect(ctx.__calls.some((c: any) => c.url.includes("/undo"))).toBe(true);
  });
});
