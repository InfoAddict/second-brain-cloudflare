/**
 * Tier 2's two rendering decisions: how a memory's verdicts are put into
 * words, and what a capture tells you it did.
 *
 * Both translate pipeline state into sentences, which is exactly where a
 * wrong mapping is invisible in a screenshot — `volatility:state` rendering
 * as "Durable" would look perfectly fine and be a lie.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function load(): any {
  const els = new Map<string, any>();
  const makeEl = () => ({ style: {} as Record<string, string>, innerHTML: "", className: "", dataset: {} as any, appendChild() {}, querySelectorAll: () => [], querySelector: () => null });
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
    fetch: () => Promise.reject(new Error("no network in this test")),
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ["public/js/tags.js", "public/utils.js", "public/js/memory-crud.js", "public/js/remember.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

describe("memory detail — what the brain knows", () => {
  it("puts each verdict into words rather than showing the tag", () => {
    const ctx = load();
    ctx.renderViewBrain({
      tags: ["work", "kind:semantic", "status:canonical", "volatility:state"],
      importance_score: 4,
      recall_count: 7,
    });
    const html = ctx.__els.get("view-brain").innerHTML;
    expect(html).toContain("Fact");        // kind:semantic
    expect(html).toContain("Trusted");     // status:canonical
    expect(html).toContain("Current");     // volatility:state
    expect(html).toContain("verify");      // the gloss, not the raw value
    expect(html).toContain("7 times");
    expect(html).not.toContain("kind:");   // never the storage syntax
  });

  it("draws importance as dots so a number out of five means something", () => {
    const ctx = load();
    ctx.renderViewBrain({ tags: [], importance_score: 3 });
    const html = ctx.__els.get("view-brain").innerHTML;
    expect(html).toContain("●●●○○");
  });

  it("stays silent about contradictions that never happened", () => {
    const ctx = load();
    ctx.renderViewBrain({ tags: [], importance_score: 2, contradiction_losses: 0 });
    expect(ctx.__els.get("view-brain").innerHTML).not.toContain("disagreed");

    ctx.renderViewBrain({ tags: [], importance_score: 2, contradiction_losses: 2 });
    expect(ctx.__els.get("view-brain").innerHTML).toContain("disagreed with this 2 times");
  });

  it("warns when recall cannot see the memory at all", () => {
    const ctx = load();
    ctx.renderViewBrain({ tags: [], indexed: false });
    expect(ctx.__els.get("view-brain").innerHTML).toContain("Not indexed");
  });

  it("hides itself entirely when there is nothing to report", () => {
    const ctx = load();
    ctx.renderViewBrain({ tags: [] });
    expect(ctx.__els.get("view-brain").style.display).toBe("none");
  });
});

describe("citation chips", () => {
  function render(text: string) {
    const ctx: any = { console };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync(resolve(ROOT, "public/js/ui-chat.js"), "utf8"), ctx);
    return ctx.renderAnswerMarkdown(text) as string;
  }

  it("turns a bracketed number into a chip carrying its source index", () => {
    const html = render("On Aug 6 you shipped 2.2.3 [1], then fixed import [3].");
    expect(html).toContain('data-cite="1"');
    expect(html).toContain('data-cite="3"');
  });

  it("leaves prose untouched when there is nothing to cite", () => {
    expect(render("No citations here.")).not.toContain("cite");
  });
});

describe("capture receipts", () => {
  const headline = (result: any, typed: string[] = []) => {
    const ctx = load();
    return ctx.captureReceipt(result, typed).innerHTML as string;
  };

  it("reports the plain case as stored, with what it was filed under", () => {
    const html = headline({ ok: true, id: "x", tags: ["work", "pricing", "kind:episodic"] });
    expect(html).toContain("stored to brain");
    expect(html).toContain("work");
    expect(html).toContain("pricing");
    // System tags are the brain's bookkeeping, not something to report back.
    expect(html).not.toContain("kind:episodic");
  });

  it("shows tags the pipeline found in the content, not just the ones typed", () => {
    const html = headline({ ok: true, id: "x", tags: ["from-content"] }, ["typed"]);
    expect(html).toContain("from-content");
  });

  it("names each outcome the capture pipeline can reach", () => {
    expect(headline({ action: "merged" })).toContain("merged into an existing memory");
    expect(headline({ action: "replaced" })).toContain("replaced an outdated memory");
    expect(headline({ resolved_conflict: "abc" })).toContain("something older now disagrees");
    expect(headline({ kept_canonical: "abc" })).toContain("stored as a draft");
    expect(headline({ warning: "similar" })).toContain("close to something you already had");
  });

  it("explains an outcome rather than only labelling it", () => {
    expect(headline({ action: "merged" })).toContain("You had written about this before");
    expect(headline({ kept_canonical: "abc" })).toContain("kept unconfirmed");
  });
});
