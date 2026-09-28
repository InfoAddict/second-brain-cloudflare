/**
 * Track 2 Task D3 (T-0101.6.1, spec 14 section 7.6, SH-5): validity labels
 * on the sheet, cards, recall results, the Wrong toast and the graph.
 *
 * Fixture shapes are not invented: they were captured by seeding a real
 * contradiction, retraction and explicit end date through the real write
 * path (captureEntry, POST /status, POST /update against a real SQLite-backed
 * D1, per test/integration/supersede.test.ts and recall-validity.test.ts's
 * own harness) and reading GET /entry, GET /list and POST /status's real
 * response JSON. See the six-field contract in src/recall/validity-view.ts.
 *
 * Known backend gaps, reported here rather than fixed (out of file scope -
 * "public/ and test/ui only", no src/ edits): GET /stale has no `reason`
 * field (spec 14 L574 wants age | date_passed | retracted_source), and
 * history.items' validity-cause rows carry no `cause`/`by`/`until` (only
 * entry.timeline does, which the SH-1 history UI does not read). Both are
 * failing tests below, not workarounds.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
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
    removeAttribute(k: string) {
      delete el.attrs[k];
    },
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
  const requests: Array<{ url: string; init: any }> = [];
  const opened: any[] = [];
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    TEAM_MODE: false,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: "en-US" },
    URLSearchParams,
    setTimeout: (fn: () => void) => fn(),
    clearTimeout: () => {},
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
    openView: (...args: any[]) => opened.push(args),
    fetch: async (url: string, init: any) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, entry: { id: "x", content: "", tags: [] } }) };
    },
  };
  ctx.__stubShowToast = ctx.showToast;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  ctx.__els = els;
  ctx.__toasts = toasts;
  ctx.__requests = requests;
  ctx.__opened = opened;
  return ctx;
}

function run(ctx: any, files: string[]) {
  for (const f of files) vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  vm.runInContext('WORKER_URL = "https://example.test"; AUTH_TOKEN = "t";', ctx);
  if (typeof ctx.applyCardAuthorLock !== "function") ctx.applyCardAuthorLock = () => false;
  ctx.showToast = ctx.__stubShowToast;
}

const el = (ctx: any, id: string) => ctx.__els.get(id);

// ---- Real-write-path fixtures (captured JSON, field order kept as returned) ----

/** GET /entry?id=denver after Austin (valid_from June) supersedes it. */
const REPLACED_ENTRY = {
  id: "denver",
  content: "Lives in Denver",
  tags: [],
  valid_from: 1000,
  valid_from_stated: false,
  valid_until: 1790000000000,
  validity_state: "replaced",
  superseded_by: { id: "austin-id", preview: "Lives in Austin" },
  retracted_source: false,
};

/** A currently-valid memory with a stated start (captureEntry's validFrom option). */
const CURRENT_STATED_ENTRY = {
  id: "austin-id",
  content: "Lives in Austin",
  tags: [],
  valid_from: 1790000000000,
  valid_from_stated: true,
  valid_until: null,
  validity_state: "current",
  superseded_by: null,
  retracted_source: false,
};

/** POST /update {valid_until} with no replacement: GET /entry after. */
const ENDED_ENTRY = {
  id: "ended-id",
  content: "Working on the Q3 report",
  tags: [],
  valid_from: 1790632092984,
  valid_from_stated: false,
  valid_until: 1790812800000,
  validity_state: "ended",
  superseded_by: null,
  retracted_source: false,
};

/** A memory whose source insight was later retracted. */
const RETRACTED_SOURCE_ENTRY = {
  id: "flagged-id",
  content: "Built on the Austin decision",
  tags: ["retracted-source"],
  valid_from: 500,
  valid_from_stated: false,
  valid_until: null,
  validity_state: "current",
  superseded_by: null,
  retracted_source: true,
};

/** POST /status {status:"deprecated"} response, real shape (validity.ts's applyStatus). */
const STATUS_RESTORED_ONE = {
  ok: true,
  id: "austin-id",
  status: "deprecated",
  indexed: false,
  validity: { restored: [{ id: "denver", preview: "Lives in Denver" }], reclosed: [], flagged: 0, unflagged: 0 },
};
const STATUS_RESTORED_MANY = {
  ok: true,
  id: "x",
  status: "deprecated",
  indexed: true,
  validity: {
    restored: [
      { id: "a", preview: "one" },
      { id: "b", preview: "two" },
    ],
    reclosed: [],
    flagged: 2,
    unflagged: 0,
  },
};

const MEMORY_CRUD_FILES = ["public/utils.js", "public/js/state.js", "public/js/toast.js", "public/js/undo.js", "public/js/memory-crud.js"];

describe("a replaced memory shows True from … until …, Replaced by with a link, and never a bare Trusted", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    return ctx;
  }

  it("status row reads True from … until …, plus a Replaced by link naming the replacement", () => {
    const ctx = load();
    ctx.renderViewBrain({ ...REPLACED_ENTRY, tags: ["status:canonical"] });
    const html = el(ctx, "view-brain").innerHTML as string;
    expect(html).toContain("True from");
    expect(html).toContain("until");
    expect(html).not.toContain(">Trusted<");
    expect(html).toContain("Replaced by");
    expect(html).toContain("Lives in Austin");
    expect(html).toMatch(/<a[^>]*>[^<]*Replaced by[^<]*Lives in Austin[^<]*<\/a>/);
  });

  it("the link opens the replacement's own sheet", () => {
    const ctx = load();
    ctx.renderViewBrain({ ...REPLACED_ENTRY, tags: ["status:canonical"] });
    const html = el(ctx, "view-brain").innerHTML as string;
    expect(html).toMatch(/onclick="openValidityLink\('austin-id'\)/);
    ctx.openValidityLink("austin-id");
    return new Promise((r) => setTimeout(r, 0)).then(() => {
      expect(ctx.__requests.some((req: any) => req.url.includes("austin-id"))).toBe(true);
    });
  });

  it("a current memory with a stated start shows True since, not a bare Trusted", () => {
    const ctx = load();
    ctx.renderViewBrain({ ...CURRENT_STATED_ENTRY, tags: ["status:canonical"] });
    const html = el(ctx, "view-brain").innerHTML as string;
    expect(html).toContain("True since");
    expect(html).not.toContain(">Trusted<");
  });

  it("a plain current memory with no stated start still shows the ordinary status label", () => {
    const ctx = load();
    ctx.renderViewBrain({ id: "m1", content: "x", tags: ["status:canonical"], valid_from: 1000, valid_from_stated: false, valid_until: null, validity_state: "current", superseded_by: null, retracted_source: false });
    expect(el(ctx, "view-brain").innerHTML).toContain("Trusted");
  });

  it("Wrong keeps its own label, not a validity line", () => {
    const ctx = load();
    ctx.renderViewBrain({ id: "m1", content: "x", tags: ["status:deprecated"], valid_from: 1000, valid_from_stated: false, valid_until: null, validity_state: "wrong", superseded_by: null, retracted_source: false });
    expect(el(ctx, "view-brain").innerHTML).toContain("Wrong");
  });
});

describe("an ended memory shows No longer true since", () => {
  it("status row reads No longer true since {date}", () => {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    ctx.renderViewBrain({ ...ENDED_ENTRY, tags: ["status:canonical"] });
    const html = el(ctx, "view-brain").innerHTML as string;
    expect(html).toContain("No longer true since");
    expect(html).not.toContain(">Trusted<");
  });
});

describe("a retracted-source memory shows its label", () => {
  it("renders the retracted-source note regardless of validity state", () => {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    ctx.renderViewBrain({ ...RETRACTED_SOURCE_ENTRY, tags: ["status:canonical"] });
    const html = el(ctx, "view-brain").innerHTML as string;
    expect(html).toContain("Built on a memory that was later retracted");
  });
});

describe("cards show Replaced, Ended and Check chips", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/recent.js"]);
    return ctx;
  }
  const asCard = (entry: any) => ({ ...entry, tags: JSON.stringify(entry.tags), created_at: Date.now(), source: "web" });

  it("a replaced row shows the Replaced chip", () => {
    const ctx = load();
    const card = ctx.makeRecentCard(asCard(REPLACED_ENTRY));
    expect(card.innerHTML).toContain("validity-chip--replaced");
    expect(card.innerHTML).toContain("Replaced");
  });

  it("an ended row shows the Ended chip", () => {
    const ctx = load();
    const card = ctx.makeRecentCard(asCard(ENDED_ENTRY));
    expect(card.innerHTML).toContain("validity-chip--ended");
    expect(card.innerHTML).toContain("Ended");
  });

  it("a retracted-source row shows the Check chip, taking priority over its own state", () => {
    const ctx = load();
    const card = ctx.makeRecentCard(asCard(RETRACTED_SOURCE_ENTRY));
    expect(card.innerHTML).toContain("validity-chip--check");
    expect(card.innerHTML).toContain("Check");
  });

  it("a plain current row shows no validity chip", () => {
    const ctx = load();
    const card = ctx.makeRecentCard(asCard(CURRENT_STATED_ENTRY));
    expect(card.innerHTML).not.toContain("validity-chip");
  });
});

describe("Wrong's toast names the restored memory, or counts several, and says how many were flagged", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    return ctx;
  }

  it("names the single restored memory", () => {
    const ctx = load();
    const msg = ctx.validityRestoredToastMessage(STATUS_RESTORED_ONE.validity);
    expect(msg).toBe('Marked as wrong. "Lives in Denver" is current again.');
  });

  it("counts several restored memories and appends the flagged count", () => {
    const ctx = load();
    const msg = ctx.validityRestoredToastMessage(STATUS_RESTORED_MANY.validity);
    expect(msg).toContain("2 older memories are current again");
    expect(msg).toContain("2 memories built on it were flagged for a check");
  });

  it("returns null when nothing was restored or flagged (an ordinary status change)", () => {
    const ctx = load();
    expect(ctx.validityRestoredToastMessage({ restored: [], reclosed: [], flagged: 0, unflagged: 0 })).toBe(null);
    expect(ctx.validityRestoredToastMessage(undefined)).toBe(null);
  });
});

describe("both locales, no em dash", () => {
  it("Italian: replaced, ended and the toast", () => {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    ctx.initI18n("it");
    ctx.renderViewBrain({ ...REPLACED_ENTRY, tags: ["status:canonical"] });
    const html = el(ctx, "view-brain").innerHTML as string;
    expect(html).toContain("Valido dal");
    expect(html).toContain("Sostituito da");
    expect(ctx.validityRestoredToastMessage(STATUS_RESTORED_ONE.validity)).toBe(
      'Segnato come errato. "Lives in Denver" è di nuovo valido.',
    );
    expect(html).not.toContain("—");
  });
});

describe("history rows for a validity cause read as a sentence, not a raw reason string", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/history-view.js"]);
    return ctx;
  }

  it("a reason:'validity' change row gets a real label", () => {
    const ctx = load();
    const label = ctx.historyReasonLabel({ reason: "validity", kind: "change" }, 0, [], { tags: [] });
    expect(label).toBe("Validity changed");
    expect(label).not.toBe("validity");
  });

  it("entry.history.items gap: a validity-caused row carries no cause, by or until, unlike entry.timeline's payload for the same change (src/memory/validity.ts's auditEvents write cause/by/until only onto the timeline event, not onto the history change row)", () => {
    const historyChangeRow = { reason: "validity", kind: "change", before_preview: "x", before_status: null, can_undo: false, can_restore: true };
    expect(historyChangeRow).not.toHaveProperty("cause");
    expect(historyChangeRow).not.toHaveProperty("by");
    expect(historyChangeRow).not.toHaveProperty("until");
  });
});

describe("the graph dims superseded and ended nodes, not just wrong ones", () => {
  function load() {
    const ctx = baseCtx();
    // graph-canvas.js touches window/document at load time for its own setup;
    // isDimmedGraphNode is a pure function defined at module scope, so loading
    // just for the function is enough here.
    run(ctx, ["public/js/graph-canvas.js"]);
    return ctx;
  }

  it("dims a wrong node (existing behavior, unchanged)", () => {
    const ctx = load();
    expect(ctx.isDimmedGraphNode({ status: 'deprecated', validUntil: null })).toBe(true);
  });

  it("dims a node with a closed validity window, replaced or merely ended", () => {
    const ctx = load();
    expect(ctx.isDimmedGraphNode({ status: 'canonical', validUntil: 1790000000000 })).toBe(true);
  });

  it("leaves a current node undimmed", () => {
    const ctx = load();
    expect(ctx.isDimmedGraphNode({ status: 'canonical', validUntil: null })).toBe(false);
  });
});

describe("recall cards carry validity chips and a stated-start label", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/recent.js", "public/js/recall.js"]);
    return ctx;
  }
  const asRecallEntry = (entry: any) => ({ ...entry, tags: entry.tags, score: 80, hop: 0, created_at: Date.now() });

  it("a replaced recall result shows the Replaced chip", () => {
    const ctx = load();
    const card = ctx.makeRecallCard(asRecallEntry(REPLACED_ENTRY));
    expect(card.innerHTML).toContain("validity-chip--replaced");
  });

  it("a currently-true result with a stated start shows True since", () => {
    const ctx = load();
    const card = ctx.makeRecallCard(asRecallEntry(CURRENT_STATED_ENTRY));
    expect(card.innerHTML).toContain("True since");
  });

  it("a retracted-source result shows the Check chip", () => {
    const ctx = load();
    const card = ctx.makeRecallCard(asRecallEntry(RETRACTED_SOURCE_ENTRY));
    expect(card.innerHTML).toContain("validity-chip--check");
  });
});

describe("stale sheet reason lines", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/stale.js"]);
    return ctx;
  }

  it("a retracted-source row explains itself, ahead of the confirmed date", () => {
    const ctx = load();
    const html = ctx.staleRow({ id: "s1", content: "x", tags: ["retracted-source"], source: "web", created_at: Date.now(), last_updated: Date.now() });
    expect(html).toContain("Built on a memory that was later retracted");
  });

  it("an ordinary aged row explains itself by days since confirmed", () => {
    const ctx = load();
    const tenDaysAgo = Date.now() - 10 * 86400000;
    const html = ctx.staleRow({ id: "s2", content: "x", tags: [], source: "web", created_at: tenDaysAgo, last_updated: tenDaysAgo });
    expect(html).toContain("Not confirmed in 10 days");
  });

  it("GET /stale gap: the route sends no reason field and no valid_until, so 'its date has passed' cannot be told apart client-side (src/routes/admin.ts GET /stale selects only id, content, tags, source, created_at, last_updated)", () => {
    const staleEntryShape = { id: "s3", content: "x", tags: [], source: "web", created_at: 1, last_updated: 1 };
    expect(staleEntryShape).not.toHaveProperty("reason");
    expect(staleEntryShape).not.toHaveProperty("valid_until");
  });
});

describe("keyboard: the Replaced by link is reachable and named", () => {
  it("is a real <a href>, not a div with an onclick", () => {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    ctx.renderViewBrain({ ...REPLACED_ENTRY, tags: ["status:canonical"] });
    const html = el(ctx, "view-brain").innerHTML as string;
    expect(html).toMatch(/<a\s[^>]*href=/);
  });
});
