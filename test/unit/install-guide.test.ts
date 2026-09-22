/**
 * public/js/install-guide.js's detection logic: a small, honest platform
 * enum from a UA string (+ userAgentData where present), standalone
 * suppression, and the beforeinstallprompt capture/replay. No DOM beyond
 * window/navigator — test/ui/install-guide.test.ts covers the sheet itself.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function load(opts: {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean };
  standaloneMedia?: boolean;
  iosStandalone?: boolean;
} = {}) {
  const windowListeners = new Map<string, ((ev: unknown) => void)[]>();
  const ctx: any = {
    console,
    module: { exports: {} },
    navigator: {
      userAgent: opts.userAgent ?? "",
      platform: opts.platform ?? "",
      maxTouchPoints: opts.maxTouchPoints ?? 0,
      userAgentData: opts.userAgentData,
      standalone: opts.iosStandalone,
    },
    window: {
      matchMedia: (query: string) => ({
        matches: query === "(display-mode: standalone)" ? !!opts.standaloneMedia : false,
      }),
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type)!.push(fn);
      },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/install-guide.js"), "utf8"), ctx);
  const fireBeforeInstallPrompt = (event: any) => {
    for (const fn of windowListeners.get("beforeinstallprompt") ?? []) fn(event);
  };
  return { ctx, exports: ctx.module.exports, fireBeforeInstallPrompt };
}

describe("detectPlatform", () => {
  const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.6045.109 Mobile/15E148 Safari/604.1";
  const IOS_FIREFOX = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/119.0 Mobile/15E148 Safari/605.1.15";
  const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36";
  const ANDROID_FIREFOX = "Mozilla/5.0 (Android 13; Mobile; rv:119.0) Gecko/119.0 Firefox/119.0";
  const ANDROID_SAMSUNG = "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36";
  const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
  const DESKTOP_MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

  it("iPhone Safari -> ios-safari", () => {
    const { exports } = load({ userAgent: IPHONE_SAFARI });
    expect(exports.detectPlatform()).toBe("ios-safari");
  });

  it("Chrome on iOS (CriOS) -> ios-other", () => {
    const { exports } = load({ userAgent: IOS_CHROME });
    expect(exports.detectPlatform()).toBe("ios-other");
  });

  it("Firefox on iOS (FxiOS) -> ios-other", () => {
    const { exports } = load({ userAgent: IOS_FIREFOX });
    expect(exports.detectPlatform()).toBe("ios-other");
  });

  it("Android Chrome -> android-chromium", () => {
    const { exports } = load({ userAgent: ANDROID_CHROME });
    expect(exports.detectPlatform()).toBe("android-chromium");
  });

  it("Samsung Internet (Chromium-based) -> android-chromium", () => {
    const { exports } = load({ userAgent: ANDROID_SAMSUNG });
    expect(exports.detectPlatform()).toBe("android-chromium");
  });

  it("Android Firefox -> android-firefox", () => {
    const { exports } = load({ userAgent: ANDROID_FIREFOX });
    expect(exports.detectPlatform()).toBe("android-firefox");
  });

  it("Desktop Windows Chrome -> desktop", () => {
    const { exports } = load({ userAgent: DESKTOP_CHROME });
    expect(exports.detectPlatform()).toBe("desktop");
  });

  it("Desktop Mac Safari -> desktop", () => {
    const { exports } = load({ userAgent: DESKTOP_MAC_SAFARI });
    expect(exports.detectPlatform()).toBe("desktop");
  });

  /**
   * iPadOS 13+ Safari sends a plain desktop Mac UA by default ("request
   * desktop site" is the default, not an opt-in) — indistinguishable from a
   * real Mac by UA string alone. The documented decision: treat
   * platform === 'MacIntel' with multi-touch (maxTouchPoints > 1, a real
   * Mac reports 0) as an iPad, landing on ios-safari. A false negative here
   * (an iPad correctly detected as desktop) just means a slightly generic
   * guide, not a broken one — the fallback is honest either way.
   */
  it("iPadOS Safari's desktop-UA quirk -> ios-safari (multi-touch MacIntel)", () => {
    const { exports } = load({ userAgent: DESKTOP_MAC_SAFARI, platform: "MacIntel", maxTouchPoints: 5 });
    expect(exports.detectPlatform()).toBe("ios-safari");
  });

  it("a real Mac (MacIntel, no touch) is not mistaken for an iPad", () => {
    const { exports } = load({ userAgent: DESKTOP_MAC_SAFARI, platform: "MacIntel", maxTouchPoints: 0 });
    expect(exports.detectPlatform()).toBe("desktop");
  });

  it("an unrecognized mobile UA falls back to unknown, not desktop", () => {
    const { exports } = load({ userAgent: "Mozilla/5.0 (Mobile; KaiOS)" });
    expect(exports.detectPlatform()).toBe("unknown");
  });

  it("an empty/missing UA falls back to unknown territory honestly (desktop, no mobile signal)", () => {
    const { exports } = load({ userAgent: "" });
    expect(exports.detectPlatform()).toBe("desktop");
  });

  it("uses userAgentData.mobile as a supplementary signal when the UA string alone does not look mobile", () => {
    const { exports } = load({ userAgent: "Mozilla/5.0 (Linux; SomeDevice)", userAgentData: { mobile: true } });
    expect(exports.detectPlatform()).toBe("unknown");
  });
});

describe("isStandalone", () => {
  it("is true when display-mode: standalone matches", () => {
    const { exports } = load({ standaloneMedia: true });
    expect(exports.isStandalone()).toBe(true);
  });

  it("is true when navigator.standalone is true (iOS)", () => {
    const { exports } = load({ iosStandalone: true });
    expect(exports.isStandalone()).toBe(true);
  });

  it("is false in an ordinary browser tab", () => {
    const { exports } = load({ standaloneMedia: false, iosStandalone: false });
    expect(exports.isStandalone()).toBe(false);
  });
});

describe("needsInstallGuide", () => {
  const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36";
  const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

  it("is true on a mobile browser that is not installed", () => {
    const { exports } = load({ userAgent: ANDROID_CHROME, standaloneMedia: false });
    expect(exports.needsInstallGuide()).toBe(true);
  });

  it("is false once installed (standalone), even on mobile", () => {
    const { exports } = load({ userAgent: ANDROID_CHROME, standaloneMedia: true });
    expect(exports.needsInstallGuide()).toBe(false);
  });

  it("is false on desktop, standalone or not", () => {
    const { exports } = load({ userAgent: DESKTOP_CHROME, standaloneMedia: false });
    expect(exports.needsInstallGuide()).toBe(false);
  });
});

describe("beforeinstallprompt capture and replay", () => {
  it("has no native prompt before the event fires", () => {
    const { exports } = load();
    expect(exports.hasNativeInstallPrompt()).toBe(false);
  });

  it("captures the event, preventing the default mini-infobar", () => {
    const { exports, fireBeforeInstallPrompt } = load();
    const preventDefault = vi.fn();
    fireBeforeInstallPrompt({ preventDefault, prompt: vi.fn(), userChoice: Promise.resolve({ outcome: "accepted" }) });

    expect(preventDefault).toHaveBeenCalled();
    expect(exports.hasNativeInstallPrompt()).toBe(true);
  });

  it("triggerNativeInstallPrompt calls prompt() on the captured event and awaits userChoice", async () => {
    const { exports, fireBeforeInstallPrompt } = load();
    const prompt = vi.fn();
    fireBeforeInstallPrompt({ preventDefault: () => {}, prompt, userChoice: Promise.resolve({ outcome: "accepted" }) });

    const result = await exports.triggerNativeInstallPrompt();

    expect(prompt).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("is one-shot: a second trigger without a new event does nothing", async () => {
    const { exports, fireBeforeInstallPrompt } = load();
    const prompt = vi.fn();
    fireBeforeInstallPrompt({ preventDefault: () => {}, prompt, userChoice: Promise.resolve({ outcome: "accepted" }) });
    await exports.triggerNativeInstallPrompt();

    const result = await exports.triggerNativeInstallPrompt();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
    expect(exports.hasNativeInstallPrompt()).toBe(false);
  });

  it("triggerNativeInstallPrompt resolves false when nothing was ever captured", async () => {
    const { exports } = load();
    await expect(exports.triggerNativeInstallPrompt()).resolves.toBe(false);
  });
});
