/**
 * Pure drawing helpers behind the "Memories over time" chart. No DOM: these
 * are math, ported from docs/design-mockups/dashboard/template.html.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function load() {
  const ctx: any = { console };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/chart.js"), "utf8"), ctx);
  return ctx;
}

describe("chart math", () => {
  const { monotonePath, niceMax, stackSeries } = load();

  it("draws a monotone cubic path through every point", () => {
    const d = monotonePath([[0, 0], [10, 5], [20, 2], [30, 8]]);
    expect(d.startsWith("M")).toBe(true);
    expect((d.match(/C/g) || []).length).toBe(3);
  });

  it("rounds up to a nice axis maximum", () => {
    expect(niceMax(12.6)).toBe(15);
    expect(niceMax(7)).toBe(8);
    expect(niceMax(6.4 * 1.06)).toBe(8);
  });

  it("stacks series into cumulative per-row tops", () => {
    expect(stackSeries([{ s: [1, 2] }, { s: [3, 4] }])).toEqual([
      [1, 3],
      [3, 7],
    ]);
  });
});
