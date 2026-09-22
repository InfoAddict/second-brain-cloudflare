/**
 * The install guide's DOM-facing half (public/js/install-guide.js): the
 * sheet body per platform, the Android Chromium native-prompt shortcut, and
 * the once-per-session nudge banner. Pure detection (detectPlatform,
 * isStandalone, beforeinstallprompt capture) is test/unit/install-guide.test.ts;
 * this file needs document/t(), so it lives here instead.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function load(opts: { userAgent?: string; standaloneMedia?: boolean; locale?: "en" | "it" } = {}) {
  const els = new Map<string, any>();
  const makeEl = (id?: string) => ({
    id,
    hidden: true,
    innerHTML: "",
    style: {} as Record<string, string>,
    classList: { add: vi.fn(), remove: vi.fn(), contains: () => false },
  });
  let sessionStore = new Map<string, string>();
  const listeners = new Map<string, (ev: unknown) => void>();
  const ctx: any = {
    console,
    module: { exports: {} },
    closeMenu: vi.fn(),
    navigator: { userAgent: opts.userAgent ?? "" },
    window: {
      matchMedia: () => ({ matches: !!opts.standaloneMedia }),
      addEventListener: (type: string, fn: (ev: unknown) => void) => listeners.set(type, fn),
    },
    sessionStorage: {
      getItem: (k: string) => sessionStore.get(k) ?? null,
      setItem: (k: string, v: string) => sessionStore.set(k, v),
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      querySelectorAll: () => [],
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, opts.locale ?? "en");
  for (const f of ["public/utils.js", "public/js/install-guide.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  ctx.__resetSession = () => sessionStore.clear();
  ctx.__fireBeforeInstallPrompt = (event: unknown) => listeners.get("beforeinstallprompt")?.(event);
  return ctx;
}

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_FIREFOX = "Mozilla/5.0 (Android 13; Mobile; rv:119.0) Gecko/119.0 Firefox/119.0";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36";
const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const UNKNOWN_MOBILE = "Mozilla/5.0 (Mobile; KaiOS)";

describe("renderInstallGuideBody — step cards per platform", () => {
  it("iOS Safari: share icon then Add to Home Screen", () => {
    const ctx = load({ userAgent: IPHONE_SAFARI });

    ctx.renderInstallGuideBody();

    const body = ctx.__els.get("install-guide-body");
    expect(body.innerHTML).toContain("<svg");
    expect(body.innerHTML).toContain("Add to Home Screen");
  });

  it("Android Firefox: menu icon then Install/Add to Home screen", () => {
    const ctx = load({ userAgent: ANDROID_FIREFOX });

    ctx.renderInstallGuideBody();

    const body = ctx.__els.get("install-guide-body");
    expect(body.innerHTML).toContain("ti-dots-vertical");
    expect(body.innerHTML).toContain("Install");
  });

  it("unknown platform falls back to one generic instruction line", () => {
    const ctx = load({ userAgent: UNKNOWN_MOBILE });

    ctx.renderInstallGuideBody();

    const body = ctx.__els.get("install-guide-body");
    expect(body.innerHTML).toContain("Add to Home Screen");
    expect(body.innerHTML).not.toContain("<svg");
  });

  it("always ends with the turn-on-notifications line", () => {
    const ctx = load({ userAgent: IPHONE_SAFARI });

    ctx.renderInstallGuideBody();

    expect(ctx.__els.get("install-guide-body").innerHTML).toContain("turn on notifications");
  });

  it("Android Chromium with a live native prompt skips instructions entirely and leads with a real Install button", () => {
    const ctx = load({ userAgent: ANDROID_CHROME });
    ctx.__fireBeforeInstallPrompt({ preventDefault: () => {}, prompt: vi.fn(), userChoice: Promise.resolve({ outcome: "accepted" }) });

    ctx.renderInstallGuideBody();

    const body = ctx.__els.get("install-guide-body");
    expect(body.innerHTML).toContain("install-guide-cta");
    expect(body.innerHTML).toContain("triggerNativeInstallPrompt()");
    expect(body.innerHTML).not.toContain("<ol");
  });

  it("Android Chromium without a captured prompt falls back to the menu steps", () => {
    const ctx = load({ userAgent: ANDROID_CHROME });

    ctx.renderInstallGuideBody();

    const body = ctx.__els.get("install-guide-body");
    expect(body.innerHTML).toContain("ti-dots-vertical");
  });
});

describe("openInstallGuide / closeInstallGuide", () => {
  it("closes the menu, opens the sheet, and renders its body", () => {
    const ctx = load({ userAgent: IPHONE_SAFARI });

    ctx.openInstallGuide();

    expect(ctx.closeMenu).toHaveBeenCalled();
    expect(ctx.__els.get("install-guide-sheet").classList.add).toHaveBeenCalledWith("open");
    expect(ctx.__els.get("install-guide-body").innerHTML).not.toBe("");
  });
});

describe("the once-per-session nudge banner", () => {
  it("shows on a mobile browser tab that is not installed", () => {
    const ctx = load({ userAgent: IPHONE_SAFARI, standaloneMedia: false });

    ctx.showInstallNudge();

    expect(ctx.__els.get("install-nudge-banner").hidden).toBe(false);
  });

  it("never shows once installed (standalone)", () => {
    const ctx = load({ userAgent: IPHONE_SAFARI, standaloneMedia: true });

    ctx.showInstallNudge();

    expect(ctx.document.getElementById("install-nudge-banner").hidden).toBe(true);
  });

  it("never shows on desktop", () => {
    const ctx = load({ userAgent: DESKTOP_CHROME, standaloneMedia: false });

    ctx.showInstallNudge();

    expect(ctx.document.getElementById("install-nudge-banner").hidden).toBe(true);
  });

  it("shows only once per session — a second call is a no-op", () => {
    const ctx = load({ userAgent: IPHONE_SAFARI, standaloneMedia: false });

    ctx.showInstallNudge();
    ctx.__els.get("install-nudge-banner").hidden = true; // simulate the user dismissing it
    ctx.showInstallNudge();

    expect(ctx.__els.get("install-nudge-banner").hidden).toBe(true);
  });

  it("dismissInstallNudge hides the banner", () => {
    const ctx = load({ userAgent: IPHONE_SAFARI, standaloneMedia: false });
    ctx.showInstallNudge();

    ctx.dismissInstallNudge();

    expect(ctx.__els.get("install-nudge-banner").hidden).toBe(true);
  });

  it("openInstallGuideFromNudge dismisses the banner and opens the guide", () => {
    const ctx = load({ userAgent: IPHONE_SAFARI, standaloneMedia: false });
    ctx.showInstallNudge();

    ctx.openInstallGuideFromNudge();

    expect(ctx.__els.get("install-nudge-banner").hidden).toBe(true);
    expect(ctx.closeMenu).toHaveBeenCalled();
    expect(ctx.__els.get("install-guide-body").innerHTML).not.toBe("");
  });
});

describe("i18n: installGuide keys are translated, not silently falling back to English", () => {
  const keys = [
    "installGuide.title",
    "installGuide.why",
    "installGuide.installButton",
    "installGuide.stepShareIcon",
    "installGuide.stepAddToHomeScreen",
    "installGuide.stepMenu",
    "installGuide.stepInstallAndroid",
    "installGuide.stepGeneric",
    "installGuide.thenOpen",
    "installGuide.nudgeText",
    "installGuide.nudgeAction",
    "notifications.installToEnable",
    "notifications.installHint",
  ];

  it.each(keys)("%s differs between en and it", (key) => {
    const en = load({ locale: "en" });
    const it_ = load({ locale: "it" });

    expect(it_.t(key)).not.toBe(key);
    expect(it_.t(key)).not.toBe(en.t(key));
  });
});
