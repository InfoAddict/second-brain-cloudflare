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
  for (const f of ["public/js/tags.js", "public/utils.js", "public/js/brief.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

const empty = { ok: true, window_hours: 48, captured: 0, sources: [], patterns: [], resurface: null };

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

  it("leads with what grew, in the site's numeral-and-unit idiom", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      captured: 12,
      sources: [{ source: "claude-desktop", count: 9 }, { source: "email-gmail", count: 3 }],
    });
    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain('class="brief-num">12<');
    expect(html).toContain("memories");
    expect(html).toContain('class="brief-num">2<');
    expect(html).toContain("sources");
    expect(ctx.__els.get("recall-welcome").style.display).toBe("none");
  });

  it("says memory and source in the singular when there is one of each", () => {
    const ctx = load();
    ctx.renderBrief({ ...empty, captured: 1, sources: [{ source: "cli", count: 1 }] });
    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain(">memory<");
    expect(html).toContain(">source<");
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

  it("builds suggestions from the brain's own topics, not a fixed list", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      patterns: [{ id: "p", content: "You keep deferring #signpath and #pricing decisions." }],
    });
    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain("What about signpath?");
    expect(html).toContain("What did I decide about signpath?");
  });

  it("offers no suggestions rather than generic ones when it has no topics", () => {
    const ctx = load();
    ctx.renderBrief({ ...empty, captured: 4, sources: [{ source: "cli", count: 4 }] });
    expect(ctx.__els.get("brief").innerHTML).not.toContain("suggestion-pill");
  });
});
