/**
 * What the brief chooses to say, and — more importantly — when it says nothing.
 *
 * A home surface that manufactures activity to justify its own existence is
 * worse than an empty one, so the restraint is the feature being tested here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function load() {
  const els = new Map<string, any>();
  const makeEl = () => ({
    style: {} as Record<string, string>,
    innerHTML: "",
    className: "",
    classList: { add() {}, remove() {} },
    querySelectorAll: () => [],
    closest: () => null,
  });
  const ctx: any = {
    console,
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
    },
    fetch: () => Promise.reject(new Error("no network here")),
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/brief.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

const empty = {
  ok: true,
  window_hours: 48,
  captured: 0,
  sources: [],
  patterns: [],
  resurface: null,
  activity: [],
  topics: [],
  total: 0,
  attention: { unindexed: 0, stale: 0, patterns: 0 },
};

describe("the daily brief", () => {
  it("renders nothing at all on a quiet day", () => {
    const ctx = load();
    ctx.renderBrief(empty);
    expect(ctx.__els.get("brief").style.display).not.toBe("");
    expect(ctx.__els.get("brief").innerHTML).toBe("");
    // …and leaves the welcome hero in place rather than replacing it with a
    // panel announcing that nothing happened.
    expect(ctx.__els.get("recall-welcome").style.display).not.toBe("none");
  });

  it("leaves the headline count to the greeting and shows the panels", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      captured: 12,
      sources: [{ source: "claude-desktop", count: 9 }, { source: "email-gmail", count: 3 }],
    });
    const html = ctx.__els.get("brief").innerHTML;
    // The home greeting carries "N memories · N this week"; a second count
    // here was the same fact twice.
    expect(html).toContain("Where from");
    expect(html).toContain("Your brain, lately");
    expect(ctx.__els.get("recall-welcome").style.display).toBe("none");
  });

  it("puts pending patterns where they can actually be decided", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      patterns: [
        { id: "p1", content: "You keep deferring the pricing decision." },
        { id: "p2", content: "You review PRs in the evening." },
        { id: "p3", content: "A third that should not crowd the screen." },
      ],
    });
    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain("Pattern noticed");
    expect(html).toContain("Confirm");
    expect(html).toContain("Dismiss");
    // Two is a brief; three is a queue.
    expect(html.match(/Pattern noticed/g)).toHaveLength(2);
  });

  it("dates the resurfaced memory by name, not 8/2/2026", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      resurface: { id: "r", content: "The pricing floor is $6k.", created_at: Date.UTC(2026, 1, 8, 12) },
    });
    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain("Worth re-reading");
    expect(html).toContain("Feb 8, 2026");
  });

  it("leaves topics to the home input rather than repeating them", () => {
    const ctx = load();
    ctx.renderBrief({ ...empty, topics: [{ tag: "signpath", count: 7 }], attention: { unindexed: 1, stale: 0, patterns: 0 } });
    // The chips under the greeting already offer these as questions; a second
    // copy in a panel is the same thing twice on one screen.
    expect(ctx.__els.get("brief").innerHTML).not.toContain("Lately about");
  });

  it("keeps the days nothing happened in the activity strip", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      activity: [
        { day: 1, count: 0 },
        { day: 2, count: 8 },
        { day: 3, count: 0 },
      ],
    });
    const html = ctx.__els.get("brief").innerHTML;
    // Dropping empty days would turn a quiet fortnight into a busy-looking one.
    // Counting elements, not the substring: "spark-bar" also appears inside
    // "spark-bar--empty".
    expect(html.match(/<span class="spark-bar/g)).toHaveLength(3);
    expect(html.match(/spark-bar--empty/g)).toHaveLength(2);
  });

  it("shows where memories came from in proportion", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      captured: 10,
      sources: [{ source: "claude-desktop", count: 8 }, { source: "cli", count: 2 }],
    });
    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain("Where from");
    expect(html).toContain("ti-message-2");   // Claude's badge
    expect(html).toContain("ti-terminal-2");  // and the CLI is a terminal
    expect(html).toContain("width:80%");
  });

  it("asks for attention only when something actually needs it", () => {
    const ctx = load();
    ctx.renderBrief({ ...empty, captured: 3, attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ctx.__els.get("brief").innerHTML).not.toContain("class=\"attn\"");

    // Reason enough to render on its own: a brain whose only news is
    // "2 not searchable" still has to say so, with no panels to carry it.
    ctx.renderBrief({ ...empty, attention: { unindexed: 2, stale: 5, patterns: 0 } });
    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain("2 not searchable");
    expect(html).toContain("5 may be out of date");
  });
});
