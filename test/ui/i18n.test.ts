/**
 * Dashboard i18n: catalogs, DOM apply, and locale boot.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function loadI18n(locale?: "en" | "it") {
  const store = new Map<string, string>();
  const els: any[] = [];
  const makeEl = (attrs: Record<string, string> = {}) => {
    const el: any = {
      attrs: { ...attrs },
      textContent: "",
      innerHTML: "",
      hasAttribute(name: string) {
        return name in this.attrs || (name === "data-i18n-html" && "data-i18n-html" in this.attrs);
      },
      getAttribute(name: string) {
        return this.attrs[name] ?? null;
      },
      setAttribute(name: string, value: string) {
        this.attrs[name] = value;
      },
    };
    els.push(el);
    return el;
  };
  const ctx: any = {
    console,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
    navigator: { language: "en-US" },
    document: {
      documentElement: { lang: "en" },
      querySelectorAll(sel: string) {
        if (sel === "[data-i18n]") return els.filter((e) => e.getAttribute("data-i18n"));
        return [];
      },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/i18n.js"), "utf8"), ctx);
  if (locale) ctx.initI18n(locale);
  else ctx.initI18n();
  return { ctx, makeEl, store };
}

describe("dashboard i18n", () => {
  it("translates dotted keys and falls back to English", () => {
    const { ctx } = loadI18n("it");
    expect(ctx.t("menu.appearance")).toBe("Aspetto");
    expect(ctx.t("menu.disconnect")).toBe("Disconnetti");
    expect(ctx.t("no.such.key")).toBe("no.such.key");
  });

  it("interpolates and picks plurals", () => {
    const { ctx } = loadI18n("en");
    expect(ctx.tPlural("nav.statusCount", 1)).toBe("1 memory stored");
    expect(ctx.tPlural("nav.statusCount", 5)).toBe("5 memories stored");
    expect(ctx.t("auth.serverError", { status: "503" })).toBe("Server error: 503");
  });

  it("applies data-i18n to the DOM", () => {
    const { ctx, makeEl } = loadI18n("it");
    const label = makeEl({ "data-i18n": "menu.appearance" });
    const input = makeEl({
      "data-i18n": "auth.tokenPlaceholder",
      "data-i18n-attr": "placeholder",
    });
    const hint = makeEl({ "data-i18n": "home.hintHtml", "data-i18n-html": "" });
    ctx.applyI18nDom();
    expect(label.textContent).toBe("Aspetto");
    expect(input.getAttribute("placeholder")).toMatch(/password/i);
    expect(hint.innerHTML).toContain("#tag");
  });

  it("persists sb-locale and sets documentElement.lang", () => {
    const { ctx, store } = loadI18n("it");
    expect(store.get("sb-locale")).toBe("it");
    expect(ctx.document.documentElement.lang).toBe("it");
    expect(ctx.getLocale()).toBe("it");
    expect(ctx.localeTag()).toBe("it-IT");
  });
});
