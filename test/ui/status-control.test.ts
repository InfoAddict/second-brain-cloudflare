/**
 * SH-3: the status control (Trusted / Unconfirmed / Wrong) on the memory
 * sheet. Ships built now; releases only after BE-9 lands (13-ux-build-spec.md
 * section 5.2).
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
    tabIndex: 0,
    textContent: "",
    innerHTML: "",
    className: "",
    onclick: null,
    onkeydown: null,
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
    focus() {
      this.focused = true;
    },
    focused: false,
    appendChild() {},
    remove() {},
    querySelectorAll: () => [] as any[],
    querySelector: () => null as any,
  };
  return el;
}

function makeStatusButtons() {
  return ["canonical", "draft", "deprecated"].map((status) => {
    const btn = makeEl();
    btn.dataset.status = status;
    return btn;
  });
}

function load(fetchImpl?: (url: string, init?: any) => Promise<any>) {
  const els = new Map<string, any>();
  const buttons = makeStatusButtons();
  const calls: Array<{ url: string; init?: any }> = [];
  const ctx: any = {
    console,
    calls,
    confirm: () => {
      throw new Error("confirm() must not be used");
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
    querySelectorAll: (sel: string) => (sel.includes(".status-option") ? buttons : []),
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
  const group = ctx.document.getElementById("view-status");
  group.querySelectorAll = (sel: string) => (sel.includes(".status-option") ? buttons : []);
  ctx.__els = els;
  ctx.__calls = calls;
  ctx.__buttons = buttons;
  return ctx;
}

function btn(ctx: any, status: string) {
  return ctx.__buttons.find((b: any) => b.dataset.status === status);
}

describe("the status control", () => {
  it("renders three options with the current one checked", () => {
    const ctx = load();
    ctx.renderViewStatus({ id: "e1", tags: ["status:draft"] });
    expect(btn(ctx, "canonical").attrs["aria-checked"]).toBe("false");
    expect(btn(ctx, "draft").attrs["aria-checked"]).toBe("true");
    expect(btn(ctx, "deprecated").attrs["aria-checked"]).toBe("false");
    expect(btn(ctx, "draft").tabIndex).toBe(0);
    expect(btn(ctx, "canonical").tabIndex).toBe(-1);
    expect(ctx.__els.get("view-status-caption").textContent).toBe(
      "Saved, but not confirmed yet. It shows up in search, and a newer memory can replace it.",
    );
  });

  it("arrow keys move and select", async () => {
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      expect(url).toContain("/status");
      expect(JSON.parse(init.body)).toEqual({ id: "e1", status: "draft" });
      return { ok: true, json: async () => ({ ok: true, indexed: true }) };
    });
    const ctx = load(fetchImpl);
    const entry = { id: "e1", tags: ["status:canonical"] };
    ctx.renderViewStatus(entry);
    const canonical = btn(ctx, "canonical");
    canonical.onkeydown({ key: "ArrowRight", preventDefault() {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(btn(ctx, "draft").focused).toBe(true);
  });

  it("selecting posts /status and shows the undo toast", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, indexed: true }) }));
    const ctx = load(fetchImpl);
    const entry = { id: "e1", tags: ["status:canonical"] };
    ctx.renderViewStatus(entry);
    await btn(ctx, "deprecated").onclick();
    await Promise.resolve();
    await Promise.resolve();
    const toastHtml = ctx.__els.get("app-toast").innerHTML as string;
    expect(toastHtml).toContain("Marked as wrong");
    expect(toastHtml).toContain("Undo");
  });

  it("keyword-only note when indexed is false", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, indexed: false }) }));
    const ctx = load(fetchImpl);
    const entry = { id: "e1", tags: ["status:deprecated"] };
    ctx.renderViewStatus(entry);
    await btn(ctx, "canonical").onclick();
    await Promise.resolve();
    await Promise.resolve();
    const toastHtml = ctx.__els.get("app-toast").innerHTML as string;
    expect(toastHtml).toContain("Marked as trusted");
    expect(toastHtml).toContain("Search finds it only by its exact words");
  });

  it("locked for a non-author teammate", () => {
    const ctx = load();
    const entry = { id: "e1", tags: ["status:canonical"], can_edit: false, actor_name: "Ana" };
    ctx.renderViewStatus(entry);
    ctx.applyAuthorLock(entry);
    expect(btn(ctx, "canonical").disabled).toBe(true);
    expect(btn(ctx, "draft").disabled).toBe(true);
    expect(btn(ctx, "deprecated").disabled).toBe(true);
  });

  it("deprecated shows Wrong, never Superseded", () => {
    const ctx = load();
    expect(ctx.viewStatusLabel("deprecated")).toBe("Wrong");
    expect(ctx.viewStatusLabel("deprecated")).not.toBe("Superseded");
  });

  it("both locales", () => {
    const ctx = load();
    const en = vm.runInContext("I18N_EN", ctx).status;
    const it = vm.runInContext("I18N_IT", ctx).status;
    expect(Object.keys(en).sort()).toEqual(Object.keys(it).sort());
    for (const key of Object.keys(en)) {
      expect(it[key], key).toBeTruthy();
    }
    ctx.initI18n("it");
    ctx.renderViewStatus({ id: "e1", tags: ["status:deprecated"] });
    expect(ctx.__els.get("view-status-caption").textContent).toBe(
      "Non vero, o da non usare. La ricerca lo esclude, per te e per i tuoi strumenti di IA. Puoi cambiarlo in qualsiasi momento.",
    );
  });
});
