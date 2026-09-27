/**
 * UI review fix: SH-1's history row actions and SH-3's status control both
 * can show a toast while #view-sheet stays open. At a narrow, bottom-anchored
 * viewport the toast's default position collided with the sheet's fixed
 * action row; showToast now measures both and lifts the toast clear only
 * when they would actually overlap.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function makeRectEl(rect: { top: number; bottom: number; height: number }) {
  return {
    getBoundingClientRect: () => rect,
    querySelector: () => null,
  };
}

function makeToastEl(height: number) {
  return {
    id: "",
    style: {} as Record<string, string>,
    className: "",
    innerHTML: "",
    classList: {
      add() {},
      remove() {},
      contains: () => false,
    },
    setAttribute() {},
    querySelector: () => null,
    getBoundingClientRect: () => ({ height }),
  };
}

function load(sheet?: any) {
  const els = new Map<string, any>();
  if (sheet) els.set("view-sheet", sheet);
  const toast = makeToastEl(50);
  const ctx: any = {
    console,
    window: {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  ctx.document = {
    getElementById: (id: string) => els.get(id) ?? null,
    createElement: () => toast,
    body: {
      appendChild(el: any) {
        els.set(el.id, el);
      },
    },
  };
  ctx.window.innerHeight = 844;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/utils.js"), "utf8"), ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/toast.js"), "utf8"), ctx);
  ctx.__toast = toast;
  return ctx;
}

describe("toast clearance of an open sheet's action row", () => {
  it("leaves the default position when no sheet is open", () => {
    const ctx = load();
    ctx.showToast("Undone");
    expect(ctx.__toast.style.bottom).toBe("");
  });

  it("leaves the default position when the sheet's actions sit well above where the toast would land", () => {
    const sheet = {
      classList: { contains: (c: string) => c === "open" },
      querySelector: () => makeRectEl({ top: 400, bottom: 450, height: 50 }),
    };
    const ctx = load(sheet);
    ctx.showToast("Undone");
    // toastTopAtDefault = 844 - 24 - 50 = 770, which is below actionsRect.bottom (450): no overlap.
    expect(ctx.__toast.style.bottom).toBe("");
  });

  it("lifts the toast clear of the sheet's action row when they would overlap", () => {
    const sheet = {
      classList: { contains: (c: string) => c === "open" },
      querySelector: () => makeRectEl({ top: 800, bottom: 844, height: 44 }),
    };
    const ctx = load(sheet);
    ctx.showToast("Undone");
    // toastTopAtDefault = 844 - 24 - 50 = 770, which IS below actionsRect.bottom (844): overlap.
    // bottom = innerHeight - actionsRect.top + 12 = 844 - 800 + 12 = 56.
    expect(ctx.__toast.style.bottom).toBe("56px");
  });

  it("does nothing when the sheet element carries no 'open' class", () => {
    const sheet = {
      classList: { contains: () => false },
      querySelector: () => makeRectEl({ top: 800, bottom: 844, height: 44 }),
    };
    const ctx = load(sheet);
    ctx.showToast("Undone");
    expect(ctx.__toast.style.bottom).toBe("");
  });
});
