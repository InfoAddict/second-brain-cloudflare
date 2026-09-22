/**
 * The due sheet (js/due.js): GET /due rendered as a list with Done, Snooze
 * and Not-a-commitment actions, plus the #due/<id> deep link a push
 * notification's tap lands on. Mirrors test/ui/loops.test.ts's harness.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function load(responses: any[] = [], { hash = "" }: { hash?: string } = {}) {
  const els = new Map<string, any>();
  const makeEl = (id?: string) => ({
    id,
    hidden: false,
    disabled: false,
    innerHTML: "",
    textContent: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, contains: () => false },
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    scrollIntoView: vi.fn(),
    dataset: {} as Record<string, string>,
    addEventListener() {},
  });
  let callIndex = 0;
  const fetchCalls: { url: string; init?: any }[] = [];
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    closeMenu: () => {},
    showToast: () => {},
    history: { replaceState: vi.fn() },
    window: { location: { hash, pathname: "/", search: "" } },
    location: { hash },
    fetch: async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      const body = responses[Math.min(callIndex++, responses.length - 1)] ?? { ok: true };
      if (body instanceof Error) throw body;
      return { ok: true, json: async () => body };
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/due.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  ctx.__fetchCalls = fetchCalls;
  return ctx;
}

const dueResponse = (overrides: any = {}) => ({
  ok: true,
  overdue: [{ id: "e1", content: "File the annual report in full", label: "File the report", tags: ["task"], when_at: Date.UTC(2027, 0, 15), when_kind: "due", when_source: "model" }],
  upcoming: [],
  counts: { overdue: 1, upcoming: 0 },
  ...overrides,
});

describe("the due sheet", () => {
  it("shows what is due", async () => {
    const ctx = load([dueResponse()]);

    await ctx.loadDueQueue();

    const html = ctx.__els.get("due-list").innerHTML;
    expect(html).toContain("File the report");
  });

  it("says so plainly when nothing is due", async () => {
    const ctx = load([{ ok: true, overdue: [], upcoming: [], counts: { overdue: 0, upcoming: 0 } }]);

    await ctx.loadDueQueue();

    expect(ctx.__els.get("due-list").innerHTML).toContain("Nothing due");
  });

  it("offers done, snooze (tomorrow/next week) and not-a-commitment on each row", async () => {
    const ctx = load([dueResponse()]);

    await ctx.loadDueQueue();

    const html = ctx.__els.get("due-list").innerHTML;
    expect(html).toContain("resolveDue('e1', 'done', true");
    expect(html).toContain("snoozeDue('e1', 'tomorrow'");
    expect(html).toContain("snoozeDue('e1', 'next-week'");
    expect(html).toContain("resolveDue('e1', 'clear', false");
  });

  it("shows full content and tags only for the highlighted (deep-linked) row", async () => {
    const ctx = load([dueResponse({
      overdue: [
        { id: "e1", content: "File the annual report in full", label: "File the report", tags: ["task", "finance"], when_at: Date.UTC(2027, 0, 15) },
        { id: "e2", content: "Something else entirely due soon", label: "Something else", tags: [], when_at: Date.UTC(2027, 0, 16) },
      ],
    })]);

    await ctx.loadDueQueue("e1");

    const html = ctx.__els.get("due-list").innerHTML;
    expect(html).toContain("File the annual report in full"); // full content on the highlighted row
    expect(html).toContain("finance"); // its tags
    expect(html).toContain("Something else"); // the other row stays compact (label only)
    expect(html).not.toContain("Something else entirely due soon");
  });
});

describe("resolving a due item", () => {
  it("'done' on a task-tagged entry calls /loops/resolve", async () => {
    const ctx = load([dueResponse(), { ok: true }]);
    await ctx.loadDueQueue();

    await ctx.resolveDue("e1", "done", true, { disabled: false });

    expect(ctx.__fetchCalls[1].url).toBe("https://example.test/loops/resolve");
    expect(JSON.parse(ctx.__fetchCalls[1].init.body)).toEqual({ id: "e1", action: "done" });
  });

  it("'done' on a non-task entry calls /due/clear", async () => {
    const ctx = load([dueResponse({ overdue: [{ id: "e1", content: "x", label: "x", tags: [], when_at: 1 }] }), { ok: true }]);
    await ctx.loadDueQueue();

    await ctx.resolveDue("e1", "done", false, { disabled: false });

    expect(ctx.__fetchCalls[1].url).toBe("https://example.test/due/clear");
    expect(JSON.parse(ctx.__fetchCalls[1].init.body)).toEqual({ id: "e1" });
  });

  it("'not a commitment' calls /due/clear", async () => {
    const ctx = load([dueResponse(), { ok: true }]);
    await ctx.loadDueQueue();

    await ctx.resolveDue("e1", "clear", false, { disabled: false });

    expect(ctx.__fetchCalls[1].url).toBe("https://example.test/due/clear");
  });

  it("drops the row from the sheet once resolved", async () => {
    const ctx = load([dueResponse(), { ok: true }]);
    await ctx.loadDueQueue();

    await ctx.resolveDue("e1", "clear", false, { disabled: false });

    expect(ctx.__els.get("due-list").innerHTML).not.toContain("File the report");
  });

  it("snoozes to tomorrow via /due/snooze with a future ISO date", async () => {
    const ctx = load([dueResponse(), { ok: true }]);
    await ctx.loadDueQueue();

    await ctx.snoozeDue("e1", "tomorrow", { disabled: false });

    expect(ctx.__fetchCalls[1].url).toBe("https://example.test/due/snooze");
    const body = JSON.parse(ctx.__fetchCalls[1].init.body);
    expect(body.id).toBe("e1");
    expect(new Date(body.until).getTime()).toBeGreaterThan(Date.now());
  });

  it("re-enables the button and keeps the row on a failed action", async () => {
    const ctx = load([dueResponse(), { ok: false, error: "nope" }]);
    await ctx.loadDueQueue();
    const btn = { disabled: false };

    await ctx.resolveDue("e1", "clear", false, btn);

    expect(btn.disabled).toBe(false);
    expect(ctx.__els.get("due-list").innerHTML).toContain("File the report");
  });
});

describe("handleDueHash", () => {
  it("opens the due sheet at the id named in #due/<id>", async () => {
    const ctx = load([dueResponse()], { hash: "#due/e1" });
    let openedWith: string | undefined;
    ctx.openDueSheet = (id?: string) => { openedWith = id; };

    ctx.handleDueHash();

    expect(openedWith).toBe("e1");
  });

  it("clears the hash so a refresh does not reopen the sheet", async () => {
    const ctx = load([dueResponse()], { hash: "#due/e1" });
    ctx.openDueSheet = () => {};

    ctx.handleDueHash();

    expect(ctx.history.replaceState).toHaveBeenCalled();
  });

  it("does nothing for a hash that is not a due deep link", async () => {
    const ctx = load([], { hash: "#other" });
    let opened = false;
    ctx.openDueSheet = () => { opened = true; };

    ctx.handleDueHash();

    expect(opened).toBe(false);
  });

  it("does nothing when there is no hash", async () => {
    const ctx = load([], { hash: "" });
    let opened = false;
    ctx.openDueSheet = () => { opened = true; };

    ctx.handleDueHash();

    expect(opened).toBe(false);
  });
});
