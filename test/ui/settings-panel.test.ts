/**
 * The dashboard settings panel: trash retention and versions kept
 * (T-0101.8.3, TR-2).
 *
 * Shares its two keys and their choices with the desktop Advanced Settings
 * window (contract 4.6; test/unit/history-trash-settings-parity.test.ts pins
 * the two surfaces against each other and against src/config.ts's RULES and
 * DEFAULTS). Admin status is read, not re-probed: team.js's existing GET
 * /team/members call already answers it, and this stubs that global rather
 * than loading all of team.js for a settings-panel-only test.
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
    hidden: false,
    disabled: false,
    innerHTML: "",
    textContent: "",
    value: "",
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
  };
}

function load(configResponse: any, opts: { admin?: boolean } = {}) {
  const els = new Map<string, any>();
  const toasts: { message: string; opts?: any }[] = [];
  const patches: any[] = [];
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    teamIsAdmin: opts.admin ?? true,
    closeMenu: () => {},
    readTeamConfig: async () => configResponse,
    showToast: (message: string, o?: any) => toasts.push({ message, opts: o }),
    fetch: async (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      patches.push({ url, method: init?.method, body });
      const forced = (ctx.__patchResponse as ((body: any) => any) | undefined)?.(body);
      if (forced) return forced;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
      body: { appendChild() {} },
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/state.js", "public/js/settings-panel.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  // state.js declares these with `let`, which shadows the ctx properties set
  // above (danger-sheet.test.ts's harness hits the same thing).
  vm.runInContext(`WORKER_URL = "https://example.test"; AUTH_TOKEN = "t"`, ctx);
  ctx.__els = els;
  ctx.__toasts = toasts;
  ctx.__patches = patches;
  return ctx;
}

const el = (ctx: any, id: string) => ctx.document.getElementById(id);
const optionValues = (html: string) => [...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);

describe("shows effective values from GET /config", () => {
  it("renders both selects with the Worker's effective values", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 }, defaults: {} });
    await ctx.loadSettingsPanel();

    expect(optionValues(el(ctx, "setting-trash-retention").innerHTML)).toEqual(["7", "14", "30", "90"]);
    expect(el(ctx, "setting-trash-retention").value).toBe("14");
    expect(optionValues(el(ctx, "setting-version-keep").innerHTML)).toEqual(["10", "20", "50"]);
    expect(el(ctx, "setting-version-keep").value).toBe("20");
  });

  it("pluralizes the retention option text (days), and leaves versions kept as bare numbers", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 }, defaults: {} });
    await ctx.loadSettingsPanel();

    const retentionHtml = el(ctx, "setting-trash-retention").innerHTML;
    expect(retentionHtml).toContain(">7 days<");
    expect(retentionHtml).toContain(">14 days<");
    const keepHtml = el(ctx, "setting-version-keep").innerHTML;
    expect(keepHtml).toContain(">20<");
    expect(keepHtml).not.toContain("days");
  });
});

describe("Custom for an out-of-list value, not rewritten", () => {
  it("adds a Custom option rather than snapping to the nearest choice", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 21, VERSION_KEEP: 20 }, defaults: {} });
    await ctx.loadSettingsPanel();

    const html = el(ctx, "setting-trash-retention").innerHTML;
    expect(optionValues(html)).toEqual(["7", "14", "30", "90", "21"]);
    expect(html).toContain("Custom (21)");
    expect(el(ctx, "setting-trash-retention").value).toBe("21");
  });
});

describe("admin change PATCHes one key and offers Undo", () => {
  it("sends exactly the changed key and shows a Saved toast with Undo", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 }, defaults: {} });
    await ctx.loadSettingsPanel();

    el(ctx, "setting-trash-retention").value = "30";
    await ctx.onSettingChange("setting-trash-retention", "TRASH_RETENTION_DAYS");

    expect(ctx.__patches).toHaveLength(1);
    expect(ctx.__patches[0]).toMatchObject({ method: "PATCH", body: { TRASH_RETENTION_DAYS: 30 } });
    expect(ctx.__toasts).toHaveLength(1);
    expect(ctx.__toasts[0].message).toBe("Saved");
    expect(ctx.__toasts[0].opts.action).toBe("Undo");
  });

  it("shows the member note instead of a failure toast when a 403 arrives", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 }, defaults: {} }, { admin: true });
    await ctx.loadSettingsPanel();
    ctx.__patchResponse = () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: "forbidden" }) });

    el(ctx, "setting-trash-retention").value = "30";
    await ctx.onSettingChange("setting-trash-retention", "TRASH_RETENTION_DAYS");

    expect(ctx.__toasts).toHaveLength(0);
    expect(el(ctx, "settings-admin-note").hidden).toBe(false);
    expect(el(ctx, "setting-trash-retention").disabled).toBe(true);
  });
});

describe("Undo patches the prior value", () => {
  it("Undo sends a second PATCH with the value from before the change", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 }, defaults: {} });
    await ctx.loadSettingsPanel();

    el(ctx, "setting-trash-retention").value = "30";
    await ctx.onSettingChange("setting-trash-retention", "TRASH_RETENTION_DAYS");
    await ctx.__toasts[0].opts.onAction();

    expect(ctx.__patches).toHaveLength(2);
    expect(ctx.__patches[1]).toMatchObject({ method: "PATCH", body: { TRASH_RETENTION_DAYS: 14 } });
    expect(el(ctx, "setting-trash-retention").value).toBe("14");
  });
});

describe("member sees disabled selects and the note", () => {
  it("disables both selects and shows the admin-only note", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 }, defaults: {} }, { admin: false });
    await ctx.loadSettingsPanel();

    expect(el(ctx, "setting-trash-retention").disabled).toBe(true);
    expect(el(ctx, "setting-version-keep").disabled).toBe(true);
    expect(el(ctx, "settings-admin-note").hidden).toBe(false);
  });

  it("a solo owner (admin) sees the controls enabled and no note", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 }, defaults: {} }, { admin: true });
    await ctx.loadSettingsPanel();

    expect(el(ctx, "setting-trash-retention").disabled).toBe(false);
    expect(el(ctx, "settings-admin-note").hidden).toBe(true);
  });
});

describe("RECALL_LOG row renders only when defaults has it", () => {
  it("stays hidden while the Worker has not shipped a RECALL_LOG default", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 }, defaults: {} });
    await ctx.loadSettingsPanel();
    expect(el(ctx, "setting-recall-log-row").style.display).toBe("none");
  });

  it("shows once GET /config's defaults carries RECALL_LOG", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 }, defaults: { RECALL_LOG: false } });
    await ctx.loadSettingsPanel();
    expect(el(ctx, "setting-recall-log-row").style.display).toBe("");
  });
});

describe("both locales", () => {
  it("speaks Italian for Custom and Saved", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 21, VERSION_KEEP: 20 }, defaults: {} });
    ctx.initI18n("it");
    await ctx.loadSettingsPanel();
    expect(el(ctx, "setting-trash-retention").innerHTML).toContain("Personalizzato (21)");

    el(ctx, "setting-version-keep").value = "50";
    await ctx.onSettingChange("setting-version-keep", "VERSION_KEEP");
    expect(ctx.__toasts[0].message).toBe("Salvato");
    expect(ctx.__toasts[0].opts.action).toBe("Annulla");
  });
});

describe("Reset to default", () => {
  it("stays hidden while the effective value already is the default", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 14, VERSION_KEEP: 20 }, defaults: {} });
    await ctx.loadSettingsPanel();
    expect(el(ctx, "setting-trash-retention-reset").hidden).toBe(true);
    expect(el(ctx, "setting-version-keep-reset").hidden).toBe(true);
  });

  it("shows for an admin once the value is anything other than the default, including a Custom one", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 30, VERSION_KEEP: 20 }, defaults: {} });
    await ctx.loadSettingsPanel();
    expect(el(ctx, "setting-trash-retention-reset").hidden).toBe(false);
    expect(el(ctx, "setting-version-keep-reset").hidden).toBe(true);

    const ctxCustom = load({ config: { TRASH_RETENTION_DAYS: 21, VERSION_KEEP: 20 }, defaults: {} });
    await ctxCustom.loadSettingsPanel();
    expect(el(ctxCustom, "setting-trash-retention-reset").hidden).toBe(false);
  });

  it("never shows for a member, even on a non-default value", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 30, VERSION_KEEP: 20 }, defaults: {} }, { admin: false });
    await ctx.loadSettingsPanel();
    expect(el(ctx, "setting-trash-retention-reset").hidden).toBe(true);
  });

  it("DELETEs the key, restores the default, and hides itself again", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 30, VERSION_KEEP: 20 }, defaults: {} });
    await ctx.loadSettingsPanel();

    await ctx.resetSetting("TRASH_RETENTION_DAYS");

    expect(ctx.__patches).toHaveLength(1);
    expect(ctx.__patches[0]).toMatchObject({ method: "DELETE", url: "https://example.test/config/TRASH_RETENTION_DAYS" });
    expect(el(ctx, "setting-trash-retention").value).toBe("14");
    expect(el(ctx, "setting-trash-retention-reset").hidden).toBe(true);
    expect(ctx.__toasts[0].message).toBe("Reset to default");
  });

  it("reports a failed reset without changing the effective value", async () => {
    const ctx = load({ config: { TRASH_RETENTION_DAYS: 30, VERSION_KEEP: 20 }, defaults: {} });
    await ctx.loadSettingsPanel();
    ctx.__patchResponse = () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: "server error" }) });

    await ctx.resetSetting("TRASH_RETENTION_DAYS");

    expect(el(ctx, "setting-trash-retention").value).toBe("30");
    expect(el(ctx, "setting-trash-retention-reset").hidden).toBe(false);
    expect(ctx.__toasts[0].message).toBe("server error");
  });
});
