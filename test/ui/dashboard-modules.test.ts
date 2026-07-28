import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

const DASHBOARD_SCRIPTS = [
  "public/utils.js",
  "public/credits.js",
  "public/js/state.js",
  "public/js/api.js",
  "public/js/theme.js",
  "public/js/ui-chat.js",
  "public/js/recall.js",
  "public/js/recent.js",
  "public/js/remember.js",
  "public/js/memory-crud.js",
  "public/js/settings.js",
  "public/js/integrations.js",
  "public/js/graph-canvas.js",
  "public/js/nav.js",
  "public/js/auth.js",
  "public/js/app.js",
];

/** Handlers referenced from index.html onclick/onchange attributes. */
const REQUIRED_GLOBALS = [
  "switchTab",
  "connect",
  "showApp",
  "logout",
  "sendRecall",
  "loadRecent",
  "sendRemember",
  "openAppend",
  "openEdit",
  "confirmForget",
  "openMenu",
  "openIntegrations",
  "loadGraph",
  "graphZoom",
  "setTheme",
  "init",
];

function loadDashboardSource({ runInit = false }: { runInit?: boolean } = {}) {
  let src = DASHBOARD_SCRIPTS.map((rel) => readFileSync(resolve(ROOT, rel), "utf8")).join("\n");
  if (!runInit) src = src.replace(/\ninit\(\)\s*$/, "");
  return src;
}

function makeFakeDocument() {
  const el = () => ({
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    value: "",
    textContent: "",
    innerHTML: "",
    onclick: null,
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    querySelector: () => el(),
    querySelectorAll: () => [],
    remove() {},
    focus() {},
    closest: () => null,
    dataset: {},
    disabled: false,
    scrollHeight: 0,
    offsetHeight: 24,
  });
  return {
    documentElement: { setAttribute() {}, getAttribute: () => null },
    querySelector: () => el(),
    querySelectorAll: () => [],
    getElementById: () => el(),
    createElement: () => el(),
    body: { style: {}, appendChild() {} },
  };
}

describe("dashboard modules", () => {
  it("loads all scripts in index.html order without parse errors", () => {
    expect(() => new Function(loadDashboardSource())).not.toThrow();
  });

  it("exposes handlers required by inline HTML attributes", () => {
    const sandbox: Record<string, unknown> = {
      document: makeFakeDocument(),
      localStorage: {
        getItem: () => null,
        setItem() {},
        removeItem() {},
      },
      fetch: async () => ({ ok: true, json: async () => ({}), text: async () => "" }),
      module: undefined,
      exports: undefined,
    };
    sandbox.window = {
      location: { origin: "http://localhost" },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    };
    vm.createContext(sandbox);
    vm.runInContext(loadDashboardSource(), sandbox);
    for (const name of REQUIRED_GLOBALS) {
      expect(typeof sandbox[name], `${name} should be a function`).toBe("function");
    }
  });
});
