/**
 * A push notification's tap lands on '/#due/<entryId>'. This boots the WHOLE
 * dashboard (every script index.html loads, in its own order) with that hash
 * already set and a saved session in localStorage — the same shape a real
 * "tap notification -> browser opens/focuses the PWA" does — and checks that
 * the due sheet ends up the visible surface with the row rendered, not the
 * menu sheet left over from wherever the tab was before.
 *
 * Full boot rather than due.js in isolation: the bug this pins is an
 * interaction between showApp()'s call order and which sheet ends up
 * carrying the 'open' class, which a due.js-only harness cannot see.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

const DASHBOARD_SCRIPTS = [
  ...readFileSync(resolve(ROOT, "public/index.html"), "utf8")
    .matchAll(/<script\s+src="([^"]+)"/g),
].map(m => `public/${m[1].replace(/^\//, "")}`);

function loadDashboardSource(): string {
  return DASHBOARD_SCRIPTS.map((rel) => readFileSync(resolve(ROOT, rel), "utf8")).join("\n");
}

function makeStatefulEl(id?: string) {
  const classes = new Set<string>();
  const children: unknown[] = [];
  return {
    id,
    classList: {
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
      contains: (c: string) => classes.has(c),
      toggle: (c: string) => { classes.has(c) ? classes.delete(c) : classes.add(c); },
    },
    style: {} as Record<string, string>,
    innerHTML: "",
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    checked: false,
    children,
    dataset: {} as Record<string, string>,
    setAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    appendChild: (child: unknown) => { children.push(child); },
    querySelector: () => makeStatefulEl(),
    querySelectorAll: () => [],
    remove() {},
    focus() {},
    closest: () => null,
    addEventListener() {},
    removeEventListener() {},
    scrollIntoView() {},
    scrollHeight: 0,
    offsetHeight: 24,
  };
}

function boot(hash: string, dueFixture: any, opts: {
  raceAuth?: { readyAfterMs: number };
  /**
   * Models the real double-invocation live-traced on a cold boot: an early
   * loadDueQueue call (from some second, still-unidentified trigger — the
   * hashchange listener firing again, most plausibly, since no second
   * explicit call site exists anywhere in this codebase) whose FAILURE
   * resolves after the later, showApp-driven call's SUCCESS already
   * rendered the row — "it lands last, clobbering the successful render".
   */
  doubleInvoke?: { earlyFailureDelayMs: number };
} = {}) {
  const els = new Map<string, ReturnType<typeof makeStatefulEl>>();
  const getEl = (id?: string) => {
    if (!id) return makeStatefulEl(id);
    if (!els.has(id)) els.set(id, makeStatefulEl(id));
    return els.get(id)!;
  };

  const store = new Map<string, string>();
  store.set("sb_url", "https://example.test");
  store.set("sb_token", "t");

  const document_: any = {
    documentElement: { lang: "en", setAttribute() {}, getAttribute: () => null },
    getElementById: (id?: string) => getEl(id),
    querySelector: () => makeStatefulEl(),
    querySelectorAll: () => [],
    createElement: () => makeStatefulEl(),
    addEventListener() {},
    removeEventListener() {},
    body: { style: {}, appendChild() {} },
  };

  const bootedAt = Date.now();
  let dueCallCount = 0;
  const replaceStateCalls: unknown[] = [];
  const sandbox: any = {
    console,
    document: document_,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    navigator: { language: "en-US" },
    history: { replaceState: (...args: unknown[]) => { replaceStateCalls.push(args); } },
    fetch: async (url: string) => {
      const race = opts.raceAuth;
      if (String(url).includes("/due")) {
        if (opts.doubleInvoke) {
          dueCallCount++;
          if (dueCallCount === 1) {
            await new Promise((r) => setTimeout(r, opts.doubleInvoke!.earlyFailureDelayMs));
            return { ok: true, json: async () => ({ ok: false, error: "Unauthorized" }) };
          }
          return { ok: true, json: async () => dueFixture };
        }
        // Models a cold boot where the very first request can still race
        // whatever makes auth/the Worker fully ready — the real bug this
        // simulates, not a client-side localStorage timing issue: localStorage
        // reads are synchronous, but the FIRST authenticated round trip after
        // a fresh boot is not guaranteed to land clean.
        if (race && Date.now() - bootedAt < race.readyAfterMs) {
          return { ok: true, json: async () => ({ ok: false, error: "Unauthorized" }) };
        }
        return { ok: true, json: async () => dueFixture };
      }
      if (String(url).includes("/brief")) {
        if (race) await new Promise((r) => setTimeout(r, race.readyAfterMs));
        return { ok: true, json: async () => ({ ok: true, total: 0, patterns: [], attention: {}, sources: [] }) };
      }
      if (race) await new Promise((r) => setTimeout(r, race.readyAfterMs));
      return { ok: true, json: async () => ({ ok: true }), text: async () => "" };
    },
  };
  const windowListeners = new Map<string, Set<(ev: unknown) => void>>();
  sandbox.window = {
    location: { origin: "https://example.test", hash, pathname: "/", search: "" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (ev: unknown) => void) => {
      windowListeners.get(type)?.delete(fn);
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(loadDashboardSource(), sandbox);

  const fireWindowEvent = (type: string) => {
    for (const fn of windowListeners.get(type) ?? []) fn({ type });
  };

  return { sandbox, els, replaceStateCalls, fireWindowEvent };
}

const overdueFixture = (id: string) => ({
  ok: true,
  overdue: [{ id, content: "File the annual report in full", label: "File the report", tags: ["task"], when_at: Date.now() - 86400000, when_kind: "due", when_source: "model" }],
  upcoming: [],
  counts: { overdue: 1, upcoming: 0 },
});

describe("booting straight into a #due/<id> deep link", () => {
  it("renders the due sheet as the visible surface with the row expanded, menu closed", async () => {
    const { els } = boot("#due/e1", overdueFixture("e1"));
    // showApp()'s handlers include unawaited fetches (loadDueQueue among them).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(els.get("due-sheet")?.classList.contains("open")).toBe(true);
    expect(els.get("menu-sheet")?.classList.contains("open")).toBe(false);
    expect(els.get("due-list")?.innerHTML).toContain("due-row-e1");
    expect(els.get("due-list")?.innerHTML).toContain("File the annual report in full");
  });

  it("clears the hash so a refresh does not reopen the same sheet", async () => {
    const { replaceStateCalls } = boot("#due/e1", overdueFixture("e1"));
    await new Promise((r) => setTimeout(r, 0));

    expect(replaceStateCalls.length).toBeGreaterThan(0);
  });

  /**
   * Live bug: loading '/#due/<id>' cold reliably showed "Could not load what
   * is due." — the sheet opened, but GET /due's very first request raced
   * whatever makes the session fully ready and got a 401; calling
   * openDueSheet(id) again a couple of seconds later on the same page always
   * worked. Not a localStorage timing issue (that read is synchronous) — the
   * fixture below models it as the first authenticated round trip after boot
   * being unreliable for a short window, which is what showApp() awaiting
   * refreshAll() before handleDueHash() protects against: due's own fetch
   * no longer fires until the home screen's other panels have already made
   * (and this fixture resolves) a full round trip.
   */
  it("still renders the due row when the very first request after boot would 401", async () => {
    const { els } = boot("#due/e1", overdueFixture("e1"), { raceAuth: { readyAfterMs: 20 } });
    await new Promise((r) => setTimeout(r, 100));

    const html = els.get("due-list")?.innerHTML ?? "";
    expect(html).toContain("due-row-e1");
    expect(html).not.toContain("Could not load");
  });

  /**
   * The real-world shape a notification tap usually takes: the PWA tab is
   * already open (backgrounded, or left on the menu after enabling
   * notifications there) and public/sw.js's notificationclick focuses it and
   * calls client.navigate(targetUrl) rather than opening a fresh document.
   * That changes window.location.hash WITHOUT re-running init()/showApp(),
   * so handleDueHash — wired only into showApp() — never fires and the due
   * sheet never opens, leaving whatever was on screen (here: the menu, left
   * open from the Notifications card) in front.
   */
  it("also opens the due sheet when the hash changes after boot, not only during it", async () => {
    const { sandbox, els, fireWindowEvent } = boot("", { ok: true, overdue: [], upcoming: [], counts: { overdue: 0, upcoming: 0 } });
    await new Promise((r) => setTimeout(r, 0));
    // The menu was left open from an earlier interaction (e.g. enabling
    // notifications), same as the live report's "Your brain" screen.
    els.get("menu-sheet")?.classList.add("open");

    sandbox.window.location.hash = "#due/e1";
    sandbox.fetch = async (url: string) => {
      if (String(url).includes("/due")) return { ok: true, json: async () => overdueFixture("e1") };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    fireWindowEvent("hashchange");
    await new Promise((r) => setTimeout(r, 0));

    expect(els.get("due-sheet")?.classList.contains("open")).toBe(true);
    expect(els.get("menu-sheet")?.classList.contains("open")).toBe(false);
    expect(els.get("due-list")?.innerHTML).toContain("due-row-e1");
  });

  /**
   * Live bug on top of the earlier ordering fix (6950fc0): even with
   * handleDueHash awaiting refreshAll, the real page still showed
   * "Could not load what is due." on a cold boot. A network trace showed
   * TWO GET /due calls — a 401 and a 200 — for one boot. No second explicit
   * call site exists anywhere in this codebase (verified: handleDueHash has
   * exactly one direct caller, showApp; there is no DOMContentLoaded
   * listener, no direct call at script load, and auth.js never re-invokes
   * showApp), so the early call is modeled here directly — standing in for
   * whichever real trigger it turns out to be (most plausibly the
   * hashchange listener firing a second time for the same tap) — rather
   * than invented as a specific fake call site that might not match reality.
   * What matters, and what pins the actual fix, is the OUTCOME: a stale
   * call's result — success or failure — must never overwrite a newer
   * call's render.
   */
  it("does not let an early, slow-to-fail call clobber the later successful render", async () => {
    const { sandbox, els } = boot("#due/e1", overdueFixture("e1"), {
      doubleInvoke: { earlyFailureDelayMs: 20 },
    });

    // The early call: invoked synchronously, in the same turn boot() itself
    // ran in — before showApp's own await refreshAll() has had a single
    // microtask to resolve, let alone reach handleDueHash. This is what
    // guarantees it is the FIRST of the two invocations (and the first GET
    // /due, per doubleInvoke's counter), exactly like the live trace.
    sandbox.loadDueQueue("e1");

    // Let showApp's natural chain (refreshAll -> handleDueHash -> the SECOND,
    // successful loadDueQueue call) complete, and then let the early call's
    // delayed failure resolve after it.
    await new Promise((r) => setTimeout(r, 50));

    const html = els.get("due-list")?.innerHTML ?? "";
    expect(html).toContain("due-row-e1");
    expect(html).not.toContain("Could not load");
  });
});

/**
 * #due-sheet was added to index.html alongside the other bottom sheets
 * (#loops-sheet, #stale-sheet, ...) but never added to their shared CSS
 * rule, so it had no `display: none` default and no `.open` -> `display:
 * flex` overlay behavior — it was always laid out in normal document flow
 * rather than hidden until opened. Text-based, like test/ui/css-parses.test.ts:
 * there is no layout engine here to compute real visibility.
 */
describe("#due-sheet's CSS", () => {
  const css = readFileSync(resolve(ROOT, "public/css/main.css"), "utf8");

  it("is hidden by default alongside the other bottom sheets", () => {
    const hiddenBlock = css.match(/\/\* ============ BOTTOM SHEETS ============ \*\/([\s\S]*?)\{/);
    expect(hiddenBlock, "the bottom-sheets selector list was not found").not.toBeNull();
    expect((hiddenBlock as RegExpMatchArray)[1]).toMatch(/#due-sheet\s*[,{]/);
  });

  it("switches to display: flex when .open, alongside the other bottom sheets", () => {
    const openBlock = css.match(/#confirm-dialog\.open,([\s\S]*?)\{/);
    expect(openBlock, "the .open selector list was not found").not.toBeNull();
    expect((openBlock as RegExpMatchArray)[1]).toMatch(/#due-sheet\.open\s*[,{]/);
  });
});

/**
 * A due-sheet row reused loops.js's .task (display: flex, content and
 * actions side by side) — fine for loops' two short buttons, but due rows
 * carry up to four (Done, two snooze choices, Not a commitment), and at
 * ~1100px that squeezed the content column into a one-word-per-line sliver.
 * .due-row now stacks (content, then tags/date, then a wrapping actions
 * row) instead, mirroring .stale-row. Text-based, like the sheet-visibility
 * pin above: no layout engine here to measure the actual column width.
 */
describe("the due row's layout", () => {
  const css = readFileSync(resolve(ROOT, "public/css/main.css"), "utf8");

  it("stacks rather than sitting content and actions side by side", () => {
    const rule = css.match(/\.due-row\s*\{([\s\S]*?)\}/);
    expect(rule, ".due-row's own rule was not found").not.toBeNull();
    expect((rule as RegExpMatchArray)[1]).not.toMatch(/display:\s*flex/);
  });

  it("wraps the actions row instead of forcing every button onto one line", () => {
    const rule = css.match(/\.due-actions\s*\{([\s\S]*?)\}/);
    expect(rule, ".due-actions's rule was not found").not.toBeNull();
    expect((rule as RegExpMatchArray)[1]).toMatch(/flex-wrap:\s*wrap/);
  });
});
