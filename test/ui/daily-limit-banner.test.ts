/**
 * The free-plan daily database limit banner (T-0101.10).
 *
 * Rahil's rule: a team on the free plan must hit a clear, visible limit,
 * never silent breakage. Any dashboard API call can answer 429 with
 * { ok:false, error:"daily_limit", limit, resets_at, message }, so this
 * wraps window.fetch once rather than needing every call site across every
 * lane to check for it - these tests call the WRAPPED fetch directly, the
 * same way every other module's `fetch(...)` call will after this script
 * loads.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function makeEl(id?: string) {
  const classes = new Set<string>();
  return {
    id,
    hidden: true,
    innerHTML: "",
    className: "",
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    setAttribute() {},
  };
}

function load(opts: { admin?: boolean | null; initialResponse?: any } = {}) {
  const els = new Map<string, any>();
  const body = {
    appendChild(node: any) {
      if (node?.id) els.set(node.id, node);
    },
  };
  let nextResponse: any =
    opts.initialResponse ?? { ok: true, status: 200, json: async () => ({ ok: true }) };

  const ctx: any = {
    console,
    teamIsAdmin: opts.admin === undefined ? null : opts.admin,
    document: {
      getElementById: (id: string) => els.get(id) ?? null,
      createElement: () => makeEl(),
      body,
    },
    fetch: async () => nextResponse,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/daily-limit-banner.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  ctx.__setNextResponse = (r: any) => {
    nextResponse = r;
  };
  return ctx;
}

const el = (ctx: any, id: string) => ctx.__els.get(id);
const resp = (body: any, status = 429) => ({
  ok: status >= 200 && status < 300,
  status,
  clone() {
    return this;
  },
  json: async () => body,
});

describe("shows one persistent banner on a 429 daily_limit response", () => {
  it("the writes variant for d1_rows_written / rows_written", async () => {
    const ctx = load();
    ctx.__setNextResponse(
      resp({ ok: false, error: "daily_limit", limit: "d1_rows_written", resets_at: "2026-09-28T00:00:00.000Z" }),
    );
    await ctx.fetch("/append", { method: "POST" });

    const banner = el(ctx, "daily-limit-banner");
    expect(banner.hidden).toBe(false);
    expect(banner.innerHTML).toContain("New memories and changes can&#39;t be saved");
  });

  it("the reads variant for d1_rows_read / rows_read", async () => {
    const ctx = load();
    ctx.__setNextResponse(
      resp({ ok: false, error: "daily_limit", limit: "rows_read", resets_at: "2026-09-28T00:00:00.000Z" }),
    );
    await ctx.fetch("/list");

    const banner = el(ctx, "daily-limit-banner");
    expect(banner.hidden).toBe(false);
    expect(banner.innerHTML).toContain("can&#39;t load or save");
  });

  it("also recognizes the unprefixed 'rows_written' spelling", async () => {
    const ctx = load();
    ctx.__setNextResponse(
      resp({ ok: false, error: "daily_limit", limit: "rows_written", resets_at: "2026-09-28T00:00:00.000Z" }),
    );
    await ctx.fetch("/append");
    expect(el(ctx, "daily-limit-banner").innerHTML).toContain("can&#39;t be saved");
  });
});

describe("{time} is resets_at in the viewer's local time, time only", () => {
  it("does not print a date, only a time", async () => {
    const ctx = load();
    ctx.__setNextResponse(
      resp({ ok: false, error: "daily_limit", limit: "d1_rows_written", resets_at: "2026-09-28T00:00:00.000Z" }),
    );
    await ctx.fetch("/append");
    const html = el(ctx, "daily-limit-banner").innerHTML;
    expect(html).not.toContain("2026");
    expect(html).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("owners and admins see the upgrade link; members see the ask-owner line", () => {
  it("an admin (or a solo owner, teamIsAdmin unresolved) sees 'Move to Workers Paid'", async () => {
    const ctx = load({ admin: true });
    ctx.__setNextResponse(
      resp({ ok: false, error: "daily_limit", limit: "d1_rows_written", resets_at: "2026-09-28T00:00:00.000Z" }),
    );
    await ctx.fetch("/append");
    const html = el(ctx, "daily-limit-banner").innerHTML;
    expect(html).toContain("Move to Workers Paid");
    expect(html).toContain('href="https://dash.cloudflare.com/?to=/:account/workers-and-pages"');
    expect(html).not.toContain("Ask the owner");
  });

  it("teamIsAdmin unresolved (null) still shows the link, not the ask-owner line", async () => {
    const ctx = load({ admin: null });
    ctx.__setNextResponse(
      resp({ ok: false, error: "daily_limit", limit: "d1_rows_written", resets_at: "2026-09-28T00:00:00.000Z" }),
    );
    await ctx.fetch("/append");
    expect(el(ctx, "daily-limit-banner").innerHTML).toContain("Move to Workers Paid");
  });

  it("a member sees 'Ask the owner about moving to Workers Paid.', not the link", async () => {
    const ctx = load({ admin: false });
    ctx.__setNextResponse(
      resp({ ok: false, error: "daily_limit", limit: "d1_rows_written", resets_at: "2026-09-28T00:00:00.000Z" }),
    );
    await ctx.fetch("/append");
    const html = el(ctx, "daily-limit-banner").innerHTML;
    expect(html).toContain("Ask the owner about moving to Workers Paid.");
    expect(html).not.toContain("Move to Workers Paid");
    expect(html).not.toContain("dash.cloudflare.com");
  });
});

describe("clears itself once a later call succeeds", () => {
  it("a subsequent 2xx response hides the banner", async () => {
    const ctx = load();
    ctx.__setNextResponse(
      resp({ ok: false, error: "daily_limit", limit: "d1_rows_written", resets_at: "2026-09-28T00:00:00.000Z" }),
    );
    await ctx.fetch("/append");
    expect(el(ctx, "daily-limit-banner").hidden).toBe(false);

    ctx.__setNextResponse({ ok: true, status: 200, clone() { return this; }, json: async () => ({ ok: true }) });
    await ctx.fetch("/list");
    expect(el(ctx, "daily-limit-banner").hidden).toBe(true);
  });
});

describe("never a raw error or a generic toast for this case", () => {
  it("does not throw and does not show the banner for an ordinary 429 (not daily_limit)", async () => {
    const ctx = load();
    ctx.__setNextResponse(resp({ ok: false, error: "rate_limited" }, 429));
    await expect(ctx.fetch("/append")).resolves.toBeTruthy();
    expect(el(ctx, "daily-limit-banner")).toBeUndefined();
  });

  it("does not throw on a 429 with an unreadable body", async () => {
    const ctx = load();
    ctx.__setNextResponse({
      ok: false,
      status: 429,
      clone() { return this; },
      json: async () => { throw new Error("not json"); },
    });
    await expect(ctx.fetch("/append")).resolves.toBeTruthy();
  });

  it("the wrapped fetch still returns the real response to its caller", async () => {
    const ctx = load();
    const body = { ok: false, error: "daily_limit", limit: "d1_rows_written", resets_at: "2026-09-28T00:00:00.000Z" };
    ctx.__setNextResponse(resp(body));
    const res = await ctx.fetch("/append");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(body);
  });
});

describe("both locales", () => {
  it("speaks Italian when the page does", async () => {
    const ctx = load({ admin: true });
    ctx.initI18n("it");
    ctx.__setNextResponse(
      resp({ ok: false, error: "daily_limit", limit: "d1_rows_read", resets_at: "2026-09-28T00:00:00.000Z" }),
    );
    await ctx.fetch("/list");
    const html = el(ctx, "daily-limit-banner").innerHTML;
    expect(html).toContain("limite giornaliero gratuito del database di Cloudflare è esaurito");
    expect(html).toContain("Passa a Workers Paid");
  });

  it("a member sees the Italian ask-owner line", async () => {
    const ctx = load({ admin: false });
    ctx.initI18n("it");
    ctx.__setNextResponse(
      resp({ ok: false, error: "daily_limit", limit: "d1_rows_written", resets_at: "2026-09-28T00:00:00.000Z" }),
    );
    await ctx.fetch("/append");
    expect(el(ctx, "daily-limit-banner").innerHTML).toContain("Chiedi al proprietario di passare a Workers Paid.");
  });
});
