/**
 * UI review: on a narrow viewport with #view-sheet open, a toast moves to
 * the top of the screen (app-toast--top) rather than fighting the sheet's
 * fixed action row for the bottom edge. Desktop, and any state where no
 * sheet is open, keeps the default bottom position.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function makeToastEl() {
  const classes = new Set<string>();
  return {
    id: "",
    style: {} as Record<string, string>,
    className: "",
    innerHTML: "",
    attrs: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
    querySelector: () => null,
    __classes: classes,
  };
}

function load(sheet: any, innerWidth: number) {
  const els = new Map<string, any>();
  if (sheet) els.set("view-sheet", sheet);
  const toast = makeToastEl();
  const ctx: any = {
    console,
    window: { innerWidth },
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
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/utils.js"), "utf8"), ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/toast.js"), "utf8"), ctx);
  ctx.__toast = toast;
  return ctx;
}

function openSheet() {
  return { classList: { contains: (c: string) => c === "open" } };
}

describe("toast position relative to an open sheet", () => {
  it("moves to the top on a narrow screen with the sheet open", () => {
    const ctx = load(openSheet(), 390);
    ctx.showToast("Undone");
    expect(ctx.__toast.__classes.has("app-toast--top")).toBe(true);
  });

  it("stays at the default bottom position on a wide screen even with the sheet open", () => {
    const ctx = load(openSheet(), 1280);
    ctx.showToast("Undone");
    expect(ctx.__toast.__classes.has("app-toast--top")).toBe(false);
  });

  it("stays at the default bottom position on a narrow screen with no sheet open", () => {
    const ctx = load(null, 390);
    ctx.showToast("Undone");
    expect(ctx.__toast.__classes.has("app-toast--top")).toBe(false);
  });

  it("stays at the default bottom position when the sheet element has no 'open' class", () => {
    const closedSheet = { classList: { contains: () => false } };
    const ctx = load(closedSheet, 390);
    ctx.showToast("Undone");
    expect(ctx.__toast.__classes.has("app-toast--top")).toBe(false);
  });

  it("drops the top class again once the sheet is no longer open", () => {
    const sheet = openSheet();
    const ctx = load(sheet, 390);
    ctx.showToast("Undone");
    expect(ctx.__toast.__classes.has("app-toast--top")).toBe(true);
    sheet.classList.contains = () => false;
    ctx.showToast("Undone again");
    expect(ctx.__toast.__classes.has("app-toast--top")).toBe(false);
  });

  it("keeps role=status regardless of position", () => {
    const ctx = load(openSheet(), 390);
    ctx.showToast("Undone");
    expect(ctx.__toast.getAttribute("role")).toBe("status");
  });
});
