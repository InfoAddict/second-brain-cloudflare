/**
 * The sidebar "download the app" button.
 *
 * Two properties matter more than the rest. The button must render a working
 * href with no network at all — the GitHub API is rate limited to 60 requests
 * an hour per IP unauthenticated, so a dashboard that depended on it would
 * quietly lose its download link. And a device we ship no desktop build for
 * must never be offered a .dmg or .exe; iPadOS is the trap there, since it
 * reports itself as MacIntel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE = readFileSync(resolve(ROOT, "public/js/download-app.js"), "utf8");
const RELEASES_PAGE = "https://github.com/rahilp/second-brain-cloudflare/releases/latest";

type Anchor = {
  id: string; className: string; href: string; target: string;
  rel: string; title: string; innerHTML: string;
};

function run(opts: {
  platform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
  desktop?: boolean;
  footer?: boolean;
  existing?: boolean;
  fetchImpl?: unknown;
}) {
  const prepended: Anchor[] = [];
  const footer = { prepend: (el: Anchor) => prepended.push(el) };
  const sandbox: Record<string, unknown> = {
    navigator: {
      platform: opts.platform ?? "",
      userAgent: opts.userAgent ?? "",
      maxTouchPoints: opts.maxTouchPoints ?? 0,
    },
    document: {
      querySelector: (sel: string) => (sel === ".sb-footer" && opts.footer !== false ? footer : null),
      getElementById: (id: string) =>
        opts.existing && id === "sb-download-app" ? ({} as unknown) : null,
      createElement: () =>
        ({ id: "", className: "", href: "", target: "", rel: "", title: "", innerHTML: "" } as Anchor),
    },
    fetch: opts.fetchImpl ?? (async () => { throw new Error("network disabled"); }),
    console,
  };
  sandbox.window = sandbox;
  if (opts.desktop) sandbox.SB_DESKTOP = true;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE + "\n;renderDownloadButton();", sandbox);
  return { prepended, sandbox };
}

const MAC = { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };
const WIN = { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

describe("download button — OS detection", () => {
  it("offers the Apple icon on macOS", () => {
    const { prepended } = run({ ...MAC, footer: true });
    expect(prepended).toHaveLength(1);
    expect(prepended[0].innerHTML).toContain("ti-brand-apple");
    expect(prepended[0].innerHTML).toContain("Download for Mac");
  });

  it("offers the Windows icon on Windows", () => {
    const { prepended } = run({ ...WIN, footer: true });
    expect(prepended[0].innerHTML).toContain("ti-brand-windows");
    expect(prepended[0].innerHTML).toContain("Download for Windows");
  });

  it("falls back to a plain download icon on Linux", () => {
    const { prepended } = run({ platform: "Linux x86_64", userAgent: "X11; Linux", footer: true });
    expect(prepended[0].innerHTML).toContain("ti-download");
    expect(prepended[0].innerHTML).toContain("Download the app");
    expect(prepended[0].href).toBe(RELEASES_PAGE);
  });

  // iPadOS reports MacIntel. Without the touch check an iPad is treated as a
  // Mac and handed a .dmg it cannot open.
  it("shows nothing on an iPad reporting itself as MacIntel", () => {
    const { prepended } = run({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 5, footer: true });
    expect(prepended).toHaveLength(0);
  });

  it("shows nothing on iPhone or Android", () => {
    for (const ua of ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", "Mozilla/5.0 (Linux; Android 14)"]) {
      const { prepended } = run({ platform: "", userAgent: ua, footer: true });
      expect(prepended).toHaveLength(0);
    }
  });

  it("shows nothing when userAgentData reports a mobile client", () => {
    const prepended: Anchor[] = [];
    const sandbox: Record<string, unknown> = {
      navigator: { userAgentData: { platform: "Android", mobile: true }, platform: "", userAgent: "", maxTouchPoints: 5 },
      document: {
        querySelector: () => ({ prepend: (el: Anchor) => prepended.push(el) }),
        getElementById: () => null,
        createElement: () => ({ id: "", className: "", href: "", target: "", rel: "", title: "", innerHTML: "" }),
      },
      fetch: async () => { throw new Error("no network"); },
      console,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE + "\n;renderDownloadButton();", sandbox);
    expect(prepended).toHaveLength(0);
  });

  // A desktop we ship no build for is NOT the same as mobile: the user may
  // still be able to use one of the installers, so the releases page is useful.
  it("still shows a fallback button on an unrecognised desktop", () => {
    const { prepended } = run({ platform: "FreeBSD amd64", userAgent: "X11; FreeBSD", footer: true });
    expect(prepended).toHaveLength(1);
    expect(prepended[0].innerHTML).toContain("ti-download");
  });

  it("prefers userAgentData.platform when present", () => {
    const prepended: Anchor[] = [];
    const sandbox: Record<string, unknown> = {
      navigator: { userAgentData: { platform: "Windows" }, platform: "", userAgent: "", maxTouchPoints: 0 },
      document: {
        querySelector: () => ({ prepend: (el: Anchor) => prepended.push(el) }),
        getElementById: () => null,
        createElement: () => ({ id: "", className: "", href: "", target: "", rel: "", title: "", innerHTML: "" }),
      },
      fetch: async () => { throw new Error("no network"); },
      console,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE + "\n;renderDownloadButton();", sandbox);
    expect(prepended[0].innerHTML).toContain("ti-brand-windows");
  });
});

describe("download button — resilience", () => {
  it("renders a working href with no network at all", () => {
    const { prepended } = run({ ...MAC, footer: true });
    // The releases page is always a valid destination, so a rate-limited or
    // offline dashboard still gets the user to a download.
    expect(prepended[0].href).toBe(RELEASES_PAGE);
    expect(prepended[0].target).toBe("_blank");
    expect(prepended[0].rel).toContain("noopener");
  });

  it("upgrades the href to the exact installer once the API answers", async () => {
    const dmg = "https://github.com/rahilp/second-brain-cloudflare/releases/download/installer-v1.1.0/Second.Brain_1.1.0_universal.dmg";
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: "installer-v1.1.0",
        assets: [
          { name: "latest.json", browser_download_url: "x" },
          { name: "Second Brain_1.1.0_universal.app.tar.gz", browser_download_url: "y" },
          { name: "Second Brain_1.1.0_x64-setup.exe.sig", browser_download_url: "z" },
          { name: "Second Brain_1.1.0_universal.dmg", browser_download_url: dmg },
        ],
      }),
    }));
    const { prepended } = run({ ...MAC, footer: true, fetchImpl });
    await new Promise(r => setTimeout(r, 0));
    expect(prepended[0].href).toBe(dmg);
    expect(prepended[0].title).toContain("installer-v1.1.0");
  });

  it("picks the .exe on Windows and never a .sig", async () => {
    const exe = "https://example.test/Second.Brain_1.1.0_x64-setup.exe";
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: "installer-v1.1.0",
        assets: [
          { name: "Second Brain_1.1.0_x64-setup.exe.sig", browser_download_url: "SIG" },
          { name: "Second Brain_1.1.0_x64-setup.exe", browser_download_url: exe },
        ],
      }),
    }));
    const { prepended } = run({ ...WIN, footer: true, fetchImpl });
    await new Promise(r => setTimeout(r, 0));
    expect(prepended[0].href).toBe(exe);
  });

  it("keeps the releases page when the API errors or is rate limited", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    const { prepended } = run({ ...MAC, footer: true, fetchImpl });
    await new Promise(r => setTimeout(r, 0));
    expect(prepended[0].href).toBe(RELEASES_PAGE);
  });

  it("keeps the releases page when the release has no matching asset", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag_name: "installer-v1.1.0", assets: [{ name: "latest.json", browser_download_url: "x" }] }),
    }));
    const { prepended } = run({ ...MAC, footer: true, fetchImpl });
    await new Promise(r => setTimeout(r, 0));
    expect(prepended[0].href).toBe(RELEASES_PAGE);
  });

  it("does not call the API for an unrecognised desktop", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    run({ platform: "Linux", userAgent: "X11", footer: true, fetchImpl });
    await new Promise(r => setTimeout(r, 0));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("download button — placement", () => {
  it("renders nothing inside the desktop app", () => {
    const { prepended } = run({ ...MAC, footer: true, desktop: true });
    expect(prepended).toHaveLength(0);
  });

  it("renders nothing when the footer is absent", () => {
    const { prepended } = run({ ...MAC, footer: false });
    expect(prepended).toHaveLength(0);
  });

  it("is idempotent — a re-render cannot produce two buttons", () => {
    const { prepended } = run({ ...MAC, footer: true, existing: true });
    expect(prepended).toHaveLength(0);
  });
});

describe("download button — wiring", () => {
  it("is loaded by index.html before app.js, which calls it", () => {
    const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
    const dl = html.indexOf("js/download-app.js");
    const app = html.indexOf("js/app.js");
    expect(dl).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(-1);
    // Classic scripts, so definition order matters.
    expect(dl).toBeLessThan(app);
    expect(readFileSync(resolve(ROOT, "public/js/app.js"), "utf8")).toContain("renderDownloadButton");
  });

  it("the desktop app sets the flag that suppresses it", () => {
    const rs = readFileSync(resolve(ROOT, "installer/src-tauri/src/windows.rs"), "utf8");
    expect(rs).toContain("window.SB_DESKTOP = true");
  });
});
