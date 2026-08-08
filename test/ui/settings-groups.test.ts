/**
 * The settings sheet, after it stopped pretending to be settings.
 *
 * It held fourteen items in one undifferentiated stack — a stats panel, five
 * chore panels, a theme toggle, three data actions and an about block — of
 * which exactly one (the theme) was a setting. The Worker's behaviour is tuned
 * from the Tauri window, which is its only writer.
 *
 * Two things are worth pinning: a heading must never render over nothing, and
 * the compression queue must not read as a backlog.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function load() {
  const els = new Map<string, any>();
  const makeEl = () => ({
    hidden: false,
    innerHTML: "",
    textContent: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, contains: () => false },
    remove() { this.removed = true; },
    removed: false,
  });
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    vectorizeGraceMs: 300000,
    fetch: () => Promise.reject(new Error("no network here")),
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ["public/js/tags.js", "public/utils.js", "public/js/settings.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

const CHORES = ["patterns-section", "digest-section", "vectorize-section", "classify-section", "restore-section"];

describe("the Upkeep heading", () => {
  it("disappears on a brain with no chores pending", () => {
    // A heading over nothing reads as a broken screen, and having nothing to do
    // is the normal case.
    const ctx = load();
    for (const id of CHORES) ctx.document.getElementById(id).style.display = "none";
    ctx.syncUpkeepGroup();
    expect(ctx.__els.get("upkeep-group").hidden).toBe(true);
  });

  it("appears as soon as any one panel has something to say", () => {
    const ctx = load();
    for (const id of CHORES) ctx.document.getElementById(id).style.display = "none";
    ctx.document.getElementById("vectorize-section").style.display = "";
    ctx.syncUpkeepGroup();
    expect(ctx.__els.get("upkeep-group").hidden).toBe(false);
  });

  it("comes back with a restore, which reveals its panel directly", () => {
    const ctx = load();
    for (const id of CHORES) ctx.document.getElementById(id).style.display = "none";
    ctx.syncUpkeepGroup();
    expect(ctx.__els.get("upkeep-group").hidden).toBe(true);

    ctx.renderRestoreProgress("Restoring…", 10, 100);
    expect(ctx.__els.get("upkeep-group").hidden).toBe(false);
  });
});

describe("the compression queue", () => {
  const candidates = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ tag: `tag${i}`, count: 50 - i }));

  it("hides itself when there is nothing to compress", () => {
    const ctx = load();
    ctx.renderDigestSection([]);
    expect(ctx.__els.get("digest-section").style.display).toBe("none");
  });

  it("shows a handful rather than the whole backlog", () => {
    // Nine identical rows read as a chore list someone is failing to keep up
    // with. Candidates arrive largest-first, so the tail is the least useful.
    const ctx = load();
    ctx.renderDigestSection(candidates(9));
    const html = ctx.__els.get("digest-section").innerHTML;
    const before = html.slice(0, html.indexOf('id="digest-rest"'));
    expect(before.match(/digest-candidate-row/g)).toHaveLength(4);
    expect(html).toContain("5 more");
  });

  it("keeps the rest one tap away rather than dropping them", () => {
    const ctx = load();
    ctx.renderDigestSection(candidates(9));
    const html = ctx.__els.get("digest-section").innerHTML;
    // Every candidate is still in the DOM; the tail is only hidden.
    expect(html.match(/digest-candidate-row/g)).toHaveLength(9);
    expect(html).toContain("tag8");

    ctx.showAllDigestCandidates();
    expect(ctx.__els.get("digest-rest").hidden).toBe(false);
    expect(ctx.__els.get("digest-more").removed).toBe(true);
  });

  it("says nothing about more when there is no more", () => {
    const ctx = load();
    ctx.renderDigestSection(candidates(3));
    expect(ctx.__els.get("digest-section").innerHTML).not.toContain("more");
  });
});
