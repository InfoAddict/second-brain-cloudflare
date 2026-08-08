import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

const DASHBOARD_SCRIPTS = [
  "public/utils.js",
  "public/credits.js",
  "public/js/tags.js",
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
  "public/js/brief.js",
  "public/js/nav.js",
  "public/js/auth.js",
  "public/js/download-app.js",
  "public/js/app.js",
];

/** Keywords / literals that appear in onclick expressions but are not handlers. */
const INLINE_CALL_DENYLIST = new Set(["return", "false", "true"]);

function extractInlineHandlerNames(html: string): string[] {
  const names = new Set<string>();
  const attrPattern = /\bon\w+\s*=\s*"([^"]+)"/g;
  const callPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  for (const [, expr] of html.matchAll(attrPattern)) {
    for (const [, fn] of expr.matchAll(callPattern)) {
      if (!INLINE_CALL_DENYLIST.has(fn)) names.add(fn);
    }
  }
  return [...names].sort();
}

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
    getElementById: (_id?: string) => el(),
    createElement: () => el(),
    // Document-level listeners are real: v2.3 registers outside-click and
    // Escape handlers to dismiss row overflow menus at load time, and a
    // document without these throws before any handler is defined.
    addEventListener() {},
    removeEventListener() {},
    body: { style: {}, appendChild() {} },
  };
}

describe("dashboard modules", () => {
  const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
  const requiredGlobals = extractInlineHandlerNames(html);

  it("loads all scripts in index.html order without parse errors", () => {
    expect(() => new Function(loadDashboardSource())).not.toThrow();
  });

  it("derives a non-trivial set of inline handlers from index.html", () => {
    expect(requiredGlobals.length).toBeGreaterThanOrEqual(31);
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
    for (const name of requiredGlobals) {
      expect(typeof sandbox[name], `${name} should be a function`).toBe("function");
    }
  });

  it("renderAboutCredits populates #about-credits without throwing", () => {
    const creditsRoot = {
      innerHTML: "",
    };
    const sandbox: Record<string, unknown> = {
      document: {
        ...makeFakeDocument(),
        getElementById: (id?: string) => (id === "about-credits" ? creditsRoot : makeFakeDocument().getElementById(id)),
      },
      module: undefined,
      exports: undefined,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(resolve(ROOT, "public/credits.js"), "utf8"), sandbox);
    expect(typeof sandbox.renderAboutCredits).toBe("function");
    (sandbox.renderAboutCredits as () => void)();
    expect(creditsRoot.innerHTML).toMatch(/Created by/);
    expect(creditsRoot.innerHTML).toMatch(/Maintainers/);
    expect(creditsRoot.innerHTML).toMatch(/Rahil Pirani/);
  });
});
