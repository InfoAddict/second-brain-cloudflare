/**
 * UI review: .view-scroll's bottom padding used to be a flat 4px, nowhere
 * near the fixed action row's real height, so the last history row could
 * still scroll to a position flush against the footer rather than clear of
 * it. syncViewScrollBottomPadding measures the action row and sets padding
 * to match, so "scroll to the end" and "clear of the footer" mean the same
 * thing regardless of width, button wrap, or safe-area inset.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function makeEl(rect?: { height: number }) {
  return {
    id: "",
    style: {} as Record<string, string>,
    className: "",
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    ...(rect ? { getBoundingClientRect: () => rect } : {}),
  };
}

function load() {
  const scroll: any = makeEl();
  const actions: any = makeEl({ height: 123.4 });
  const ctx: any = {
    console,
    document: {
      querySelector: (sel: string) => (sel.includes(".view-scroll") ? scroll : sel.includes(".view-actions") ? actions : null),
      getElementById: () => null,
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  vm.runInContext(readFileSync(resolve(ROOT, "public/utils.js"), "utf8"), ctx);
  // memory-crud.js as a whole references globals (toast, undo, history-view)
  // this one pure function does not need, so only the function itself is
  // extracted rather than loading the whole file's dependency chain.
  const src = readFileSync(resolve(ROOT, "public/js/memory-crud.js"), "utf8");
  const match = src.match(/function syncViewScrollBottomPadding\(\)[\s\S]*?\n}/);
  if (!match) throw new Error("syncViewScrollBottomPadding not found in memory-crud.js");
  vm.runInContext(match[0], ctx);
  ctx.__scroll = scroll;
  ctx.__actions = actions;
  return ctx;
}

describe("syncViewScrollBottomPadding", () => {
  it("sets .view-scroll's bottom padding to the action row's real height", () => {
    const ctx = load();
    ctx.syncViewScrollBottomPadding();
    expect(ctx.__scroll.style.paddingBottom).toBe("124px"); // ceil(123.4)
  });

  it("does nothing when either element is missing", () => {
    const ctx: any = {
      console,
      document: { querySelector: () => null, getElementById: () => null },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    const src = readFileSync(resolve(ROOT, "public/js/memory-crud.js"), "utf8");
    const match = src.match(/function syncViewScrollBottomPadding\(\)[\s\S]*?\n}/)!;
    vm.runInContext(match[0], ctx);
    expect(() => ctx.syncViewScrollBottomPadding()).not.toThrow();
  });
});
