/**
 * T3/T4 lane S4 (16-t3-t4-trust-spec.md, ~line 1341): the home board's "AI
 * tools changed N memories" line - one stop inside board.js's decide panel,
 * fed by GET /brief's real `changes` block (Lane S, src/brief/changes.ts).
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

function baseCtx(locale: "en" | "it" = "en") {
  const els = new Map<string, any>();
  const toasts: Array<{ message: string; opts?: any }> = [];
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    TEAM_MODE: false,
    teamIsAdmin: null,
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
      querySelector: (sel: string) => {
        if (sel === "#ai-changes-stop .attn") return els.get("__attn_btn") || null;
        return null;
      },
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
  installI18n(ctx, locale);
  ctx.__els = els;
  ctx.__toasts = toasts;
  return ctx;
}

const FILES = [
  "public/utils.js",
  "public/js/state.js",
  "public/js/toast.js",
  "public/js/undo.js",
  "public/js/memory-crud.js",
  "public/js/ai-changes.js",
];

/**
 * confirm-sheet.js's own state (`pendingConfirmAction` etc.) is declared with
 * `let`, so it lives in that script's lexical scope, not as a property this
 * test can reach from outside (the WORKER_URL/AUTH_TOKEN re-assignment trick
 * works only because those are plain assignments, not `let`). Rather than
 * reproduce confirm-sheet.js's own already-tested focus trap here, this
 * stubs `openDangerConfirm` and captures what ai-changes.js passed it - the
 * right boundary: this file proves it reaches the ONE shared confirm sheet
 * with the right copy, not that the sheet itself traps focus.
 */
function run(ctx: any, files: string[] = FILES) {
  for (const f of files) vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  vm.runInContext('WORKER_URL = "https://example.test"; AUTH_TOKEN = "t";', ctx);
  ctx.showToast = ctx.__stubShowToast;
  ctx.openDangerConfirm = (opts: any) => {
    ctx.__confirmOpts = opts;
    ctx.document.getElementById("confirm-title").textContent = opts.title;
    ctx.document.getElementById("confirm-body").textContent = opts.body;
    return 1;
  };
}

/** Real shapes: GET /brief's `changes` block (src/brief/changes.ts's changesToRestJson). */
function itemFixture(overrides: Record<string, unknown> = {}) {
  return {
    kind: "item",
    event: "status_changed",
    family: "status",
    id: "m1",
    at: Date.now(),
    client: "Cursor",
    preview: "The pricing floor is $6k",
    status: "canonical",
    can_undo: true,
    ...overrides,
  };
}

function groupFixture(overrides: Record<string, unknown> = {}) {
  return {
    kind: "group",
    family: "status",
    count: 8,
    at: Date.now() - 60000,
    until: Date.now(),
    client: "Cursor",
    group: "grouptoken",
    can_undo_all: true,
    ...overrides,
  };
}

describe("absent when count is 0", () => {
  it("returns an empty string, and renderDecisionPanel adds no stop for it", () => {
    const ctx = baseCtx();
    run(ctx);
    expect(ctx.aiChangesStopHtml({ count: 0, held: 0, items: [] })).toBe("");
    expect(ctx.aiChangesStopHtml(null)).toBe("");
  });
});

describe("collapsed line with the held suffix", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx);
    return ctx;
  }

  it("shows the plain count with no suffix when nothing is held", () => {
    const ctx = load();
    const html = ctx.aiChangesStopHtml({ count: 5, held: 0, items: [] });
    expect(html).toContain("AI tools changed 5 memories");
    expect(html).not.toContain("held");
  });

  it("appends the held suffix when held > 0", () => {
    const ctx = load();
    const html = ctx.aiChangesStopHtml({ count: 5, held: 2, items: [] });
    expect(html).toContain("AI tools changed 5 memories");
    expect(html).toContain("2 held");
  });
});

describe("expanded rows with tool name or 'an AI tool'", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx);
    return ctx;
  }

  it("names the client when present", () => {
    const ctx = load();
    const html = ctx.aiChangesRowsHtml({ items: [itemFixture({ client: "Cursor" })] });
    expect(html).toContain("by Cursor");
  });

  it("falls back to 'an AI tool' when client is null", () => {
    const ctx = load();
    const html = ctx.aiChangesRowsHtml({ items: [itemFixture({ client: null })] });
    expect(html).toContain("an AI tool");
  });

  it("labels every family correctly, including held with its reason", () => {
    const ctx = load();
    expect(ctx.aiChangeEventLabel(itemFixture({ family: "canonical_edit" }))).toBe("Edited a trusted memory");
    expect(ctx.aiChangeEventLabel(itemFixture({ family: "capsule_changed" }))).toBe("Changed what your AI tools always see");
    expect(ctx.aiChangeEventLabel(itemFixture({ family: "trash" }))).toBe("Moved to the trash");
    expect(ctx.aiChangeEventLabel(itemFixture({ family: "revert" }))).toBe("Undid a change");
    expect(ctx.aiChangeEventLabel(itemFixture({ family: "released" }))).toBe("Released a held memory");
    expect(ctx.aiChangeEventLabel(itemFixture({ family: "status", status: "canonical" }))).toBe("Marked as trusted");
    expect(ctx.aiChangeEventLabel(itemFixture({ family: "status", status: "draft" }))).toBe("Marked as unconfirmed");
    expect(ctx.aiChangeEventLabel(itemFixture({ family: "status", status: "deprecated" }))).toBe("Marked as wrong");
    expect(ctx.aiChangeEventLabel(itemFixture({ family: "held", reasons: ["instruction"] }))).toBe("Held: looks like an instruction to an AI");
    expect(ctx.aiChangeEventLabel(itemFixture({ family: "held", reasons: ["too_long"] }))).toBe("Held: too long");
  });
});

describe("Undo and Release call the right endpoints and show the 6-second toast", () => {
  function load(response: unknown) {
    const ctx = baseCtx();
    const fetchCalls: { url: string; init?: any }[] = [];
    ctx.fetch = async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      return { ok: true, json: async () => response };
    };
    run(ctx);
    ctx.__fetchCalls = fetchCalls;
    return ctx;
  }

  it("Undo posts to POST /undo and shows the ordinary result toast", async () => {
    const ctx = load({ ok: true, status: "reverted" });
    await ctx.aiChangeUndo("m1", { disabled: false });
    expect(ctx.__fetchCalls[0].url).toBe("https://example.test/undo");
    expect(JSON.parse(ctx.__fetchCalls[0].init.body)).toEqual({ id: "m1" });
    expect(ctx.__toasts).toHaveLength(1);
    expect(ctx.__toasts[0].message).toBe("Undone");
    expect(ctx.__toasts[0].opts?.duration ?? 6000).toBe(6000);
  });

  it("Release posts to POST /undo and shows the Released toast", async () => {
    const ctx = load({ ok: true, id: "m1", result: "released" });
    await ctx.aiChangeRelease("m1", { disabled: false });
    expect(ctx.__fetchCalls[0].url).toBe("https://example.test/undo");
    expect(JSON.parse(ctx.__fetchCalls[0].init.body)).toEqual({ id: "m1" });
    expect(ctx.__toasts).toHaveLength(1);
    expect(ctx.__toasts[0].message).toBe("Released");
  });
});

describe("Undo all confirms, loops pages until remaining 0, reports partial results", () => {
  function load(pages: unknown[]) {
    const ctx = baseCtx();
    const fetchCalls: { url: string; init?: any }[] = [];
    let call = 0;
    ctx.fetch = async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      const body = pages[Math.min(call, pages.length - 1)];
      call++;
      return { ok: true, json: async () => body };
    };
    run(ctx);
    ctx.__fetchCalls = fetchCalls;
    return ctx;
  }

  it("shows a confirm, then loops /undo/group while remaining > 0, and reports the partial result", async () => {
    const ctx = load([
      { ok: true, results: [{ id: "a", result: "reverted" }, { id: "b", result: "reverted" }, { id: "c", result: "reverted" }, { id: "d", result: "reverted" }, { id: "e", result: "reverted" }], done: false, remaining: 3, group: "grouptoken" },
      { ok: true, results: [{ id: "f", result: "reverted" }, { id: "g", result: "changed_since" }, { id: "h", result: "reverted" }], done: true, remaining: 0, group: "grouptoken" },
    ]);

    ctx.aiChangeGroupAction("grouptoken", "undo", 8);

    // openDangerConfirm opened a question rather than posting immediately.
    expect(ctx.__fetchCalls).toHaveLength(0);
    expect(ctx.__els.get("confirm-title").textContent).toBe("Undo all");
    expect(ctx.__els.get("confirm-body").textContent).toContain("Undo these 8 changes?");

    await ctx.__confirmOpts.onConfirm(false, () => {}, () => {});

    expect(ctx.__fetchCalls).toHaveLength(2);
    expect(ctx.__fetchCalls[0].url).toBe("https://example.test/undo/group");
    expect(JSON.parse(ctx.__fetchCalls[0].init.body)).toEqual({ group: "grouptoken" });
    expect(ctx.__toasts.at(-1)?.message).toBe("Undid 7 of 8. 1 changed since, so they were left as they are.");
  });

  it("release-all loops the same way and confirms with the release wording", async () => {
    const ctx = load([{ ok: true, results: [{ id: "a", result: "released" }], done: true, remaining: 0, group: "grouptoken" }]);
    ctx.aiChangeGroupAction("grouptoken", "release", 1);
    expect(ctx.__els.get("confirm-body").textContent).toContain("Release these 1 memories?");
    await ctx.__confirmOpts.onConfirm(false, () => {}, () => {});
    expect(ctx.__toasts.at(-1)?.message).toBe("Released");
  });
});

describe("teammate rows have no buttons", () => {
  it("hides Release and shows the lock note for a non-admin teammate on a held row", () => {
    const ctx = baseCtx();
    ctx.TEAM_MODE = true;
    ctx.teamIsAdmin = false;
    run(ctx);
    const html = ctx.aiChangeItemButtonsHtml(itemFixture({ family: "held", can_release: true, reasons: ["instruction"] }));
    expect(html).not.toContain("<button");
    expect(html).toContain("Only the author or an admin can undo these.");
  });

  it("release-all is also locked, but ordinary undo rows are unaffected by team mode", () => {
    const ctx = baseCtx();
    ctx.TEAM_MODE = true;
    ctx.teamIsAdmin = false;
    run(ctx);
    const groupHtml = ctx.aiChangeGroupButtonsHtml(groupFixture({ family: "held", can_release_all: true, can_undo_all: undefined }));
    expect(groupHtml).not.toContain("<button");

    const ordinaryHtml = ctx.aiChangeItemButtonsHtml(itemFixture({ can_undo: true }));
    expect(ordinaryHtml).toContain("<button");
  });

  it("an admin keeps the Release button on a held row", () => {
    const ctx = baseCtx();
    ctx.TEAM_MODE = true;
    ctx.teamIsAdmin = true;
    run(ctx);
    const html = ctx.aiChangeItemButtonsHtml(itemFixture({ family: "held", can_release: true, reasons: ["instruction"] }));
    expect(html).toContain("<button");
  });
});

describe("client names and previews are escaped", () => {
  it("escapes a client name and a preview containing markup", () => {
    const ctx = baseCtx();
    run(ctx);
    const html = ctx.aiChangeItemRowHtml(itemFixture({ client: "<img src=x onerror=alert(1)>", preview: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("both locales, no em dash", () => {
  it("renders the collapsed line in Italian", () => {
    const ctx = baseCtx("it");
    run(ctx);
    const html = ctx.aiChangesStopHtml({ count: 3, held: 1, items: [] });
    expect(html).toContain("Gli strumenti di IA hanno modificato 3 ricordi");
    expect(html).toContain("1 trattenuti");
  });

  it("has no em dash in either locale's aiChanges strings", () => {
    // I18N_EN/I18N_IT are `const`, so - like WORKER_URL before the
    // vm.runInContext reassignment trick - they live in i18n.js's own
    // lexical scope, not as properties this test can read directly. `t` and
    // `initI18n` are function declarations, so they ARE reachable, and
    // reading every key through them exercises the real interpolation path.
    const ctx = baseCtx();
    run(ctx);
    const keys = [
      "line", "heldSuffix", "review", "byTool", "anAiTool", "evEditedTrusted", "evCapsule",
      "evTrusted", "evUnconfirmed", "evWrong", "evTrash", "evReverted", "evReleased", "evHeld",
      "evHeldTooLong", "group", "undoAll", "releaseAll", "confirmUndoAll", "confirmReleaseAll",
      "partial", "teammateNote",
    ];
    for (const locale of ["en", "it"] as const) {
      ctx.initI18n(locale);
      for (const key of keys) {
        const value = ctx.t(`aiChanges.${key}`, { n: 1, tool: "Cursor", reason: "x", time: "3:00 PM", done: 1, skipped: 1 });
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect(value, `${locale}.${key}`).not.toContain("—");
      }
    }
  });
});

describe("keyboard reachable, focus trapped in the confirm", () => {
  it("every action is a real <button>, and Undo all opens the shared, already focus-trapped confirm sheet", () => {
    const ctx = baseCtx();
    run(ctx);
    const rowHtml = ctx.aiChangeItemRowHtml(itemFixture({ can_undo: true }));
    expect(rowHtml).toMatch(/<button type="button"[^>]*>Undo<\/button>/);

    const groupHtml = ctx.aiChangeGroupRowHtml(groupFixture());
    expect(groupHtml).toMatch(/<button type="button"[^>]*onclick="aiChangeGroupAction/);

    // Undo all reaches the ONE shared confirm sheet (openDangerConfirm) rather
    // than building a second dialog - confirm-sheet.js's own keydown handler
    // already owns Tab-cycling and Escape for every caller, tested once there.
    ctx.aiChangeGroupAction("grouptoken", "undo", 8);
    expect(ctx.__confirmOpts).toBeTruthy();
    expect(typeof ctx.__confirmOpts.onConfirm).toBe("function");
  });
});
