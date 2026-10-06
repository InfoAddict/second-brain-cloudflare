/**
 * T3/T4 lane S5 (16-t3-t4-trust-spec.md, ~line 1355): the Held chip, the
 * sheet banner with Release, the "edited by {tool}" canonical-edit status
 * line, and the author lock - all reusing SH's existing extension points
 * (renderViewStanding's own sibling call sites in openView/hydrateView,
 * lockAuthoredControls).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function makeEl(tag = "div") {
  const kids: any[] = [];
  const children = new Map<string, any>();
  const el: any = {
    tag,
    id: "",
    className: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {} as Record<string, string>,
    disabled: false,
    hidden: false,
    title: "",
    value: "",
    textContent: "",
    onclick: null,
    attrs: {} as Record<string, string>,
    kids,
    dataset: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      el.attrs[k] = String(v);
    },
    getAttribute: (k: string) => el.attrs[k] ?? null,
    addEventListener() {},
    appendChild(c: any) {
      kids.push(c);
      return c;
    },
    remove() {},
    focus() {},
    closest: () => null,
    querySelector(sel: string) {
      if (!children.has(sel)) children.set(sel, makeEl("button"));
      return children.get(sel);
    },
    querySelectorAll: () => [],
  };
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get: () => html,
    set(v: string) {
      html = String(v);
      kids.length = 0;
    },
  });
  return el;
}

function baseCtx() {
  const els = new Map<string, any>();
  const toasts: Array<{ message: string; opts?: any }> = [];
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    TEAM_MODE: false,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: "en-US" },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    document: {
      documentElement: { lang: "en" },
      getElementById(id: string) {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: (tag: string) => makeEl(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: { appendChild() {} },
    },
    showToast: (message: string, opts?: any) => {
      toasts.push({ message, opts });
    },
  };
  ctx.__stubShowToast = ctx.showToast;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  ctx.__els = els;
  ctx.__toasts = toasts;
  return ctx;
}

function run(ctx: any, files: string[]) {
  for (const f of files) vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  vm.runInContext('WORKER_URL = "https://example.test"; AUTH_TOKEN = "t";', ctx);
  if (typeof ctx.applyCardAuthorLock !== "function") ctx.applyCardAuthorLock = () => false;
  ctx.showToast = ctx.__stubShowToast;
}

const CRUD_FILES = ["public/utils.js", "public/js/state.js", "public/js/toast.js", "public/js/undo.js", "public/js/memory-crud.js"];

describe("card shows the Held chip", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js"]);
    return ctx;
  }

  it("heldChipHtml renders the chip for every recognized hold reason", () => {
    const ctx = load();
    for (const reason of ["instruction", "hidden", "burst", "capsule"]) {
      const html = ctx.heldChipHtml([`quarantine:${reason}`]);
      expect(html, reason).toContain("Held");
      expect(html, reason).toContain("tag-chip--held");
    }
  });

  it("too_long reads its own chip text", () => {
    const ctx = load();
    expect(ctx.heldChipHtml(["quarantine:too_long"])).toContain("Held: too long");
  });

  it("renders nothing for an unheld or ordinary memory", () => {
    const ctx = load();
    expect(ctx.heldChipHtml(["work"])).toBe("");
    expect(ctx.heldChipHtml([])).toBe("");
    expect(ctx.heldChipHtml(undefined)).toBe("");
  });

  it("makeRecentCard shows the Held chip on a held memory and not on an ordinary one", () => {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/recent.js"]);
    const held = ctx.makeRecentCard({ id: "m1", content: "A very long note", tags: '["quarantine:too_long"]', created_at: Date.now(), source: "claude-desktop" });
    const ordinary = ctx.makeRecentCard({ id: "m2", content: "The pricing floor is $6k", tags: '["work"]', created_at: Date.now(), source: "claude-desktop" });
    expect(held.innerHTML).toContain("tag-chip--held");
    expect(ordinary.innerHTML).not.toContain("tag-chip--held");
  });

  it("hides the redundant Not indexed chip on a held card: the Held chip already says so", () => {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/recent.js"]);
    const old = Date.now() - 7 * 86400000 // outside the vectorize grace window, where an ordinary unindexed card would show "Not indexed"
    const held = ctx.makeRecentCard({ id: "m1", content: "A very long note", tags: '["quarantine:too_long"]', created_at: old, source: "claude-desktop" });
    const ordinary = ctx.makeRecentCard({ id: "m2", content: "The pricing floor is $6k", tags: '["work"]', created_at: old, source: "claude-desktop" });
    expect(held.innerHTML).toContain("tag-chip--held");
    expect(held.innerHTML).not.toContain("vec-chip--off");
    expect(ordinary.innerHTML).toContain("vec-chip--off");
  });

  it("a pre-existing user tag that merely looks reserved is never hidden as a hold", () => {
    const ctx = load();
    // quarantine:sample is not one of the five recognized reasons.
    expect(ctx.heldChipHtml(["quarantine:sample"])).toBe("");
    expect(ctx.humanTags(["quarantine:sample"])).toContain("quarantine:sample");
  });
});

describe("sheet banner with reason and Release", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, CRUD_FILES);
    return ctx;
  }

  it("shows the banner and Release for every ordinary hold reason", () => {
    const ctx = load();
    const cases: Array<[string, string]> = [
      ["instruction", "looks like an instruction to an AI"],
      ["hidden", "contains hidden text"],
      ["burst", "AI tools made many changes in a short time"],
      ["capsule", "changes what your AI tools always see"],
    ];
    for (const [reason, phrase] of cases) {
      ctx.renderViewHeld({ id: "m1", tags: [`quarantine:${reason}`] });
      expect(ctx.__els.get("view-held").style.display, reason).toBe("");
      expect(ctx.__els.get("view-held-line").textContent, reason).toContain(phrase);
      expect(ctx.__els.get("view-held-line").textContent, reason).toContain("It stays saved");
      expect(ctx.__els.get("view-held-release").style.display, reason).toBe("");
    }
  });

  it("hides Release and uses held.bannerOther when the viewer cannot release a company hold", () => {
    const ctx = load();
    ctx.renderViewHeld({ id: "m1", tags: ["quarantine:instruction"], can_edit: false });
    const line = ctx.__els.get("view-held-line").textContent;
    expect(line).toContain("the person who saved it or an admin releases it");
    expect(line).not.toContain(" until you release it");
    expect(ctx.__els.get("view-held-release").style.display).toBe("none");
  });

  it("shows Release and held.banner when can_edit is absent (older Worker or a solo brain)", () => {
    const ctx = load();
    ctx.renderViewHeld({ id: "m1", tags: ["quarantine:instruction"] });
    expect(ctx.__els.get("view-held-line").textContent).toContain(" until you release it");
    expect(ctx.__els.get("view-held-release").style.display).toBe("");
  });

  it("too_long gets its own complete sentence, not the generic banner template", () => {
    const ctx = load();
    ctx.renderViewHeld({ id: "m1", tags: ["quarantine:too_long"] });
    expect(ctx.__els.get("view-held-line").textContent).toBe(
      "Held out of search and away from your AI tools, because it's too long to check automatically for hidden instructions. Read it, and release it if it's fine. Shorter memories aren't held.",
    );
  });

  it("hides the banner entirely on a memory that is not held", () => {
    const ctx = load();
    ctx.renderViewHeld({ id: "m1", tags: ["work"] });
    expect(ctx.__els.get("view-held").style.display).toBe("none");
  });
});

describe("Release calls POST /undo, shows the toast, re-hydrates, and the timeline shows Released", () => {
  function load(response: unknown) {
    const ctx = baseCtx();
    const fetchCalls: { url: string; init?: any }[] = [];
    ctx.fetch = async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      if (response instanceof Error) throw response;
      return { ok: true, json: async () => response };
    };
    run(ctx, CRUD_FILES);
    ctx.hydrateView = vi.fn(); // memory-crud.js's real `function hydrateView` would otherwise win
    ctx.__fetchCalls = fetchCalls;
    return ctx;
  }

  const entry = { id: "m1", tags: ["quarantine:instruction"] };

  it("posts /undo with the id and shows a toast with an Undo action", async () => {
    const ctx = load({ ok: true, id: "m1", result: "released" });

    await ctx.releaseHeld(entry, { disabled: false });

    expect(ctx.__fetchCalls[0].url).toBe("https://example.test/undo");
    expect(JSON.parse(ctx.__fetchCalls[0].init.body)).toEqual({ id: "m1" });
    expect(ctx.__toasts).toHaveLength(1);
    expect(ctx.__toasts[0].message).toBe("Released");
    expect(ctx.__toasts[0].opts.action).toBe("Undo");
    expect(typeof ctx.__toasts[0].opts.onAction).toBe("function");
  });

  it("re-hydrates the sheet after releasing", async () => {
    const ctx = load({ ok: true, id: "m1", result: "released" });

    await ctx.releaseHeld(entry, { disabled: false });

    expect(ctx.hydrateView).toHaveBeenCalledWith("m1");
  });

  it("re-enables the button and shows a failure toast on error", async () => {
    const ctx = load({ ok: false, error: "nope" });
    const btn = { disabled: false };

    await ctx.releaseHeld(entry, btn);

    expect(btn.disabled).toBe(false);
    expect(ctx.__toasts).toHaveLength(1);
    expect(ctx.__toasts[0].message).toContain("Could not release this");
  });

  it("timelineEventLabel names held and released events", () => {
    const ctx = load({ ok: true });
    expect(ctx.timelineEventLabel("held")).toBe("Held");
    expect(ctx.timelineEventLabel("released")).toBe("Released");
  });
});

// Fixture shape confirmed against the real routes: POST /capture on a 36,000-
// byte note, then GET /entry, then POST /undo (release), then GET /entry
// again - a too_long change row carries `hold: { reason: "too_long" }`; the
// held/released events carry `kind: "event"`, `event: "held" | "released"`.
describe("history rows for a hold (history-view.js)", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/memory-crud.js", "public/js/history-view.js"]);
    return ctx;
  }

  it("a too_long change row reads 'Held: too long to check automatically', not the ordinary status-change label", () => {
    const ctx = load();
    const item = { kind: "change", reason: "status", hold: { reason: "too_long" }, before_status: null };
    expect(ctx.historyReasonLabel(item, 0, [item], { tags: ["quarantine:too_long", "status:draft"] })).toBe(
      "Held: too long to check automatically",
    );
  });

  it("an ordinary hold reason's change row keeps its own reason label (no distinct history key exists for it)", () => {
    const ctx = load();
    const item = { kind: "change", reason: "status", hold: { reason: "instruction" }, before_status: null };
    const label = ctx.historyReasonLabel(item, 0, [item], { tags: ["quarantine:instruction", "status:draft"] });
    expect(label).toContain("Status changed to");
  });

  it("a held/released row with no hold field renders its ordinary reason unaffected", () => {
    const ctx = load();
    const item = { kind: "change", reason: "update" };
    expect(ctx.historyReasonLabel(item, 0, [item], { tags: [] })).toBe("Edited");
  });
});

describe("status line shows 'edited by {tool}' for 7 days", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, CRUD_FILES);
    return ctx;
  }

  const recentDate = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

  it("names the client from the newest MCP update/append history row", () => {
    const ctx = load();
    const entry = {
      id: "m1",
      tags: [`edited-canonical:${recentDate(2)}`],
      // Real GET /entry shape: history.items, not a bare array.
      history: { items: [{ kind: "change", reason: "update", channel: "mcp", client: "Cursor", at: Date.now() }] },
    };
    ctx.renderViewStatus(entry);
    expect(ctx.__els.get("view-status-caption").textContent).toMatch(/^Trusted · edited via Cursor on /);
  });

  it("falls back to 'an AI tool' when the history row carries no client", () => {
    const ctx = load();
    const entry = {
      id: "m1",
      tags: [`edited-canonical:${recentDate(1)}`],
      history: { items: [{ kind: "change", reason: "append", channel: "mcp", client: null, at: Date.now() }] },
    };
    ctx.renderViewStatus(entry);
    expect(ctx.__els.get("view-status-caption").textContent).toBe(`Trusted · edited via an AI tool on ${ctx.formatDateUI(Date.parse(`${recentDate(1)}T00:00:00Z`), { month: "short", day: "numeric" })}`);
  });

  it("shows the ordinary help text once the label is 7 or more days old", () => {
    const ctx = load();
    const entry = { id: "m1", tags: [`edited-canonical:${recentDate(7)}`], history: { items: [] } };
    ctx.renderViewStatus(entry);
    expect(ctx.__els.get("view-status-caption").textContent).not.toContain("edited via");
    expect(ctx.__els.get("view-status-caption").textContent).toContain("Confirmed");
  });

  it("never applies to a non-canonical status, even with a fresh label", () => {
    const ctx = load();
    const entry = { id: "m1", tags: ["status:draft", `edited-canonical:${recentDate(1)}`], history: { items: [] } };
    ctx.renderViewStatus(entry);
    expect(ctx.__els.get("view-status-caption").textContent).not.toContain("edited via");
  });

  it("shows the ordinary help text when there is no canonical-edit tag at all", () => {
    const ctx = load();
    ctx.renderViewStatus({ id: "m1", tags: [], history: { items: [] } });
    expect(ctx.__els.get("view-status-caption").textContent).toContain("Confirmed");
  });

  it.each([
    ["canonical (Trusted)", []],
    ["draft (Unconfirmed)", ["status:draft"]],
    ["deprecated (Wrong)", ["status:deprecated"]],
  ])("hides the help line on a held memory, whatever the status - %s", (_label, statusTags) => {
    const ctx = load();
    ctx.renderViewStatus({ id: "m1", tags: [...statusTags, "quarantine:instruction"], history: { items: [] } });
    const caption = ctx.__els.get("view-status-caption");
    expect(caption.textContent).toBe("");
    expect(caption.style.display).toBe("none");
  });

  it("restores the help line once the memory is released", () => {
    const ctx = load();
    ctx.renderViewStatus({ id: "m1", tags: ["quarantine:instruction"], history: { items: [] } });
    ctx.renderViewStatus({ id: "m1", tags: [], history: { items: [] } });
    const caption = ctx.__els.get("view-status-caption");
    expect(caption.style.display).toBe("");
    expect(caption.textContent).toContain("Confirmed");
  });
});

describe("locked for non-authors", () => {
  it("disables Release, matching the other author-locked controls", () => {
    const ctx = baseCtx();
    run(ctx, CRUD_FILES);

    ctx.applyAuthorLock({ can_edit: false });

    const btn = ctx.__els.get("view-held-release");
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
  });

  it("leaves Release enabled for the author", () => {
    const ctx = baseCtx();
    run(ctx, CRUD_FILES);

    ctx.applyAuthorLock({ can_edit: true });

    expect(ctx.__els.get("view-held-release").disabled).toBe(false);
  });
});
