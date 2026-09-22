/**
 * The due sheet (js/due.js): GET /due rendered as a list with Done, Snooze
 * and Not-a-commitment actions, plus the #due/<id> deep link a push
 * notification's tap lands on. Mirrors test/ui/loops.test.ts's harness.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi, afterEach } from "vitest";
import { installI18n } from "./_i18n-harness";
import { makeFakeIndexedDB } from "../helpers/fake-indexeddb";

const ROOT = resolve(import.meta.dirname, "../..");

function load(responses: any[] = [], { hash = "", search = "", authToken = "t" }: { hash?: string; search?: string; authToken?: string } = {}) {
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
  const swMessageListeners: ((ev: unknown) => void)[] = [];
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: authToken,
    URLSearchParams,
    closeMenu: () => {},
    showToast: () => {},
    history: { replaceState: vi.fn() },
    window: { location: { hash, pathname: "/", search } },
    navigator: {
      serviceWorker: {
        addEventListener: (type: string, fn: (ev: unknown) => void) => {
          if (type === "message") swMessageListeners.push(fn);
        },
      },
    },
    location: { hash },
    indexedDB: makeFakeIndexedDB(),
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
  for (const f of ["public/utils.js", "public/js/pending-due.js", "public/js/due.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  ctx.__fetchCalls = fetchCalls;
  ctx.__fireSwMessage = (data: unknown) => { for (const fn of swMessageListeners) fn({ data }); };
  return ctx;
}

const dueResponse = (overrides: any = {}) => ({
  ok: true,
  overdue: [{ id: "e1", content: "File the annual report in full", label: "File the report", tags: ["task"], when_at: Date.UTC(2027, 0, 15), when_kind: "due", when_source: "model" }],
  upcoming: [],
  counts: { overdue: 1, upcoming: 0 },
  ...overrides,
});

describe("the due sheet's date display", () => {
  const originalTz = process.env.TZ;
  afterEach(() => { process.env.TZ = originalTz; });

  it("shows the calendar date a local-midnight when_at was anchored at, using the viewer's local render", async () => {
    // when_at now anchors midnight in the brain's CONFIGURED timezone
    // (src/when/timezone.ts), not UTC — so a viewer in that same real-world
    // zone reading it with ordinary local-time formatting (formatDateUI)
    // sees the intended calendar date directly. This fixture is what
    // "2026-09-23" anchored in America/New_York actually produces: midnight
    // Eastern (EDT, UTC-4) is 2026-09-23T04:00Z.
    process.env.TZ = "America/New_York";
    const localMidnight = Date.UTC(2026, 8, 23, 4); // 2026-09-23T04:00:00.000Z = Sep 23 00:00 EDT
    const ctx = load([{
      ok: true,
      overdue: [{ id: "e1", content: "File the report", label: "File the report", tags: [], when_at: localMidnight }],
      upcoming: [],
      counts: { overdue: 1, upcoming: 0 },
    }]);

    await ctx.loadDueQueue();

    const html = ctx.__els.get("due-list").innerHTML;
    expect(html).toContain("Sep 23, 2026");
    expect(html).not.toContain("Sep 22, 2026");
  });
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

describe("handleDueLink", () => {
  it("opens the due sheet at the id named in #due/<id>", async () => {
    const ctx = load([dueResponse()], { hash: "#due/e1" });
    let openedWith: string | undefined;
    ctx.openDueSheet = (id?: string) => { openedWith = id; };

    ctx.handleDueLink();

    expect(openedWith).toBe("e1");
  });

  it("clears the hash so a refresh does not reopen the sheet", async () => {
    const ctx = load([dueResponse()], { hash: "#due/e1" });
    ctx.openDueSheet = () => {};

    ctx.handleDueLink();

    expect(ctx.history.replaceState).toHaveBeenCalled();
  });

  it("does nothing for a hash that is not a due deep link", async () => {
    const ctx = load([], { hash: "#other" });
    let opened = false;
    ctx.openDueSheet = () => { opened = true; };

    ctx.handleDueLink();

    expect(opened).toBe(false);
  });

  it("does nothing when there is no hash", async () => {
    const ctx = load([], { hash: "" });
    let opened = false;
    ctx.openDueSheet = () => { opened = true; };

    ctx.handleDueLink();

    expect(opened).toBe(false);
  });

  it("ignores re-entry while its own load is still in flight — a tap has been observed to fire this twice in one boot", async () => {
    const ctx = load([dueResponse()], { hash: "#due/e1" });
    let openCount = 0;
    let resolveFirst: (() => void) | undefined;
    ctx.openDueSheet = () => new Promise<void>((resolve) => { openCount++; resolveFirst = resolve; });

    ctx.handleDueLink(); // starts the first (real) load
    ctx.handleDueLink(); // fires again before the first has settled — must be a no-op

    expect(openCount).toBe(1);

    resolveFirst!();
    await new Promise((r) => setTimeout(r, 0)); // let the .finally() clear the in-flight guard
    ctx.handleDueLink(); // a genuinely later call must still work

    expect(openCount).toBe(2);
  });

  /**
   * The REAL live sequence, per request-header capture: due.js's script-load
   * time registers the hashchange listener, and the browser's own
   * 'hashchange' (dispatched during the initial navigation into a URL with a
   * fragment — observed via the service worker's client.navigate()/
   * openWindow() path, not any call in our own JS) fires it immediately —
   * BEFORE app.js (loaded last of every script) has run init() and set
   * AUTH_TOKEN. That early call went on to fetch GET /due with
   * "Bearer " + "" and rendered the permanent loadFailed note; showApp's
   * later, properly-authenticated handleDueLink call then found the
   * in-flight guard armed (by the early, doomed call) and was swallowed as
   * re-entry — no authenticated fetch ever happened at all.
   */
  it("no-ops when AUTH_TOKEN is not yet set, leaving the hash for a later authenticated call to find", async () => {
    const ctx = load([dueResponse()], { hash: "#due/e1", authToken: "" });

    // The early, pre-auth firing — due.js's own listener, or a direct call;
    // either way this must be a complete no-op.
    ctx.handleDueLink();

    expect(ctx.__fetchCalls).toHaveLength(0);
    expect(ctx.history.replaceState).not.toHaveBeenCalled();
    // Nothing touched #due-list at all — it was never even looked up.
    expect(ctx.__els.has("due-list")).toBe(false);

    // app.js's boot completes: AUTH_TOKEN is set, then showApp calls
    // handleDueLink again — the hash is still there because the early call
    // never cleared it.
    ctx.AUTH_TOKEN = "t";
    ctx.handleDueLink();
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.__fetchCalls).toHaveLength(1);
    expect(ctx.__fetchCalls[0].init.headers.Authorization).toBe("Bearer t");
    expect(ctx.history.replaceState).toHaveBeenCalledTimes(1);
    const html = ctx.__els.get("due-list").innerHTML;
    expect(html).toContain("due-row-e1");
    expect(html).not.toContain("Could not load");
  });

  it("no-ops when WORKER_URL is not yet set", async () => {
    const ctx = load([dueResponse()], { hash: "#due/e1", authToken: "t" });
    ctx.WORKER_URL = "";

    ctx.handleDueLink();

    expect(ctx.__fetchCalls).toHaveLength(0);
    expect(ctx.history.replaceState).not.toHaveBeenCalled();
  });

  describe("the ?due=<id> query-param channel", () => {
    it("opens the due sheet at the id named in ?due=<id> and strips it, keeping the rest of the query string", async () => {
      const ctx = load([dueResponse()], { search: "?due=e1&foo=bar" });
      let openedWith: string | undefined;
      ctx.openDueSheet = (id?: string) => { openedWith = id; };

      await ctx.handleDueLink();

      expect(openedWith).toBe("e1");
      expect(ctx.history.replaceState).toHaveBeenCalledWith(null, "", "/?foo=bar");
    });

    it("strips the param down to a bare path when it was the only one", async () => {
      const ctx = load([dueResponse()], { search: "?due=e1" });
      ctx.openDueSheet = () => {};

      await ctx.handleDueLink();

      expect(ctx.history.replaceState).toHaveBeenCalledWith(null, "", "/");
    });

    it("hash still wins over the query param when both are present", async () => {
      const ctx = load([dueResponse()], { hash: "#due/from-hash", search: "?due=from-search" });
      let openedWith: string | undefined;
      ctx.openDueSheet = (id?: string) => { openedWith = id; };

      await ctx.handleDueLink();

      expect(openedWith).toBe("from-hash");
    });

    it("does nothing when there is no due param", async () => {
      const ctx = load([], { search: "?foo=bar" });
      let opened = false;
      ctx.openDueSheet = () => { opened = true; };

      await ctx.handleDueLink();

      expect(opened).toBe(false);
      expect(ctx.history.replaceState).not.toHaveBeenCalled();
    });

    it("no-ops entirely before AUTH_TOKEN is set", async () => {
      const ctx = load([dueResponse()], { search: "?due=e1", authToken: "" });
      let opened = false;
      ctx.openDueSheet = () => { opened = true; };

      await ctx.handleDueLink();

      expect(opened).toBe(false);
      expect(ctx.history.replaceState).not.toHaveBeenCalled();
    });
  });

  describe("the service worker 'message' channel (due-deep-link)", () => {
    it("opens the due sheet immediately when auth is already ready", () => {
      const ctx = load([dueResponse()]); // authToken defaults to "t"
      let openedWith: string | undefined;
      ctx.openDueSheet = (id?: string) => { openedWith = id; };

      ctx.__fireSwMessage({ type: "due-deep-link", entry_id: "e1" });

      expect(openedWith).toBe("e1");
    });

    it("ignores a message with a different or missing type", () => {
      const ctx = load([]);
      let opened = false;
      ctx.openDueSheet = () => { opened = true; };

      ctx.__fireSwMessage({ type: "something-else", entry_id: "e1" });
      ctx.__fireSwMessage({ entry_id: "e1" });

      expect(opened).toBe(false);
    });

    it("queues the id when auth is not ready yet, and delivers it once flushPendingDueLinkMessage runs after boot", () => {
      const ctx = load([dueResponse()], { authToken: "" });
      let openedWith: string | undefined;
      ctx.openDueSheet = (id?: string) => { openedWith = id; };

      ctx.__fireSwMessage({ type: "due-deep-link", entry_id: "e1" });
      expect(openedWith).toBeUndefined(); // queued, not dropped

      ctx.AUTH_TOKEN = "t"; // app.js's boot completes
      ctx.flushPendingDueLinkMessage();

      expect(openedWith).toBe("e1");
    });

    it("flushPendingDueLinkMessage is a no-op when nothing is queued", () => {
      const ctx = load([]);
      let opened = false;
      ctx.openDueSheet = () => { opened = true; };

      ctx.flushPendingDueLinkMessage();

      expect(opened).toBe(false);
    });
  });

  describe("the IndexedDB pending-record fallback (2-minute TTL)", () => {
    it("opens a fresh stashed record and clears it", async () => {
      const ctx = load([dueResponse()]);
      await ctx.stashPendingDueId("e1");
      let openedWith: string | undefined;
      ctx.openDueSheet = (id?: string) => { openedWith = id; };

      await ctx.handleDueLink();

      expect(openedWith).toBe("e1");
      expect(await ctx.readPendingDueRecord()).toBeNull();
    });

    it("ignores (but still clears) a stashed record older than 2 minutes", async () => {
      const ctx = load([]);
      // A real stash first, so the DB/store exist; then overwrite with an
      // aged timestamp — stashPendingDueId itself always uses Date.now().
      await ctx.stashPendingDueId("stale");
      // Constants, not globals: pending-due.js declares these with `const`,
      // which does not attach to the vm context the way its `function`
      // declarations do — matching the literals it uses internally.
      const db = await new Promise<any>((resolve) => {
        const req = ctx.indexedDB.open("sb-push", 1);
        req.onsuccess = () => resolve(req.result);
      });
      await new Promise<void>((resolve) => {
        const tx = db.transaction("pending", "readwrite");
        tx.objectStore("pending").put({ id: "stale", at: Date.now() - 3 * 60 * 1000 }, "due");
        tx.oncomplete = () => resolve();
      });
      let opened = false;
      ctx.openDueSheet = () => { opened = true; };

      await ctx.handleDueLink();

      expect(opened).toBe(false);
      expect(await ctx.readPendingDueRecord()).toBeNull(); // cleared even though stale
    });

    it("does not touch IndexedDB before AUTH_TOKEN is set", async () => {
      const ctx = load([], { authToken: "" });
      await ctx.stashPendingDueId("e1");

      await ctx.handleDueLink();

      // Still there — a no-op call must not have read or cleared it.
      expect((await ctx.readPendingDueRecord())?.id).toBe("e1");
    });

    it("hash and search both win over the IndexedDB fallback", async () => {
      const ctx = load([dueResponse()], { hash: "#due/from-hash" });
      await ctx.stashPendingDueId("from-idb");
      let openedWith: string | undefined;
      ctx.openDueSheet = (id?: string) => { openedWith = id; };

      await ctx.handleDueLink();

      expect(openedWith).toBe("from-hash");
      // Untouched — the hash channel won, so IndexedDB was never even read.
      expect((await ctx.readPendingDueRecord())?.id).toBe("from-idb");
    });
  });
});
