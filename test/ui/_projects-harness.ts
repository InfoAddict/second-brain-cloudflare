/**
 * Shared vm bootstrap for the Projects UI tests (list, detail, composer).
 *
 * The fake elements are scraped from public/index.html rather than listed by
 * hand: the page is the only honest source for which ids exist and which of
 * them ship hidden, so a module that reaches for an id the markup does not
 * carry gets null here exactly as it would in the browser.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "../..");

/** Page-load order for the modules Projects touches. */
export const PROJECT_SCRIPTS = [
  "public/utils.js",
  "public/js/i18n.js",
  "public/js/state.js",
  "public/js/toast.js",
  "public/js/confirm-sheet.js",
  "public/js/api.js",
  "public/js/projects.js",
];

export function makeEl(id = ""): any {
  const attrs = new Map<string, string>();
  const el: any = {
    id,
    hidden: false,
    style: {} as Record<string, string>,
    classList: {
      names: new Set<string>(),
      add(c: string) {
        el.classList.names.add(c);
      },
      remove(c: string) {
        el.classList.names.delete(c);
      },
      toggle(c: string, on?: boolean) {
        if (on ?? !el.classList.names.has(c)) el.classList.add(c);
        else el.classList.remove(c);
      },
      contains: (c: string) => el.classList.names.has(c),
    },
    focusCalls: 0,
    addEventListener() {},
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    checked: false,
    setAttribute: (k: string, v: string) => void attrs.set(k, String(v)),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    hasAttribute: (k: string) => attrs.has(k),
    removeAttribute: (k: string) => void attrs.delete(k),
    appendChild() {},
    remove() {},
    focus() {
      el.focusCalls += 1;
    },
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {} as Record<string, string>,
  };
  return el;
}

/** Every element in index.html, with its shipped hidden / display:none state. */
function pageElements(): Map<string, any> {
  const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
  const out = new Map<string, any>();
  for (const m of html.matchAll(/<[a-z][a-z0-9]*\b[^>]*?\bid="([^"]+)"[^>]*>/gi)) {
    const [tag, id] = m;
    const el = makeEl(id);
    if (/\shidden(\s|=|>|\/)/.test(tag)) el.hidden = true;
    if (/style="[^"]*display:\s*none/.test(tag)) el.style.display = "none";
    out.set(id, el);
  }
  return out;
}

export type Reply = { status?: number; body?: any };
export type Call = { method: string; path: string; query: URLSearchParams; body: any; headers: Record<string, string> };
type Handler = Reply | ((call: Call) => Reply);

export function setupProjects(opts: { routes?: Record<string, Handler>; teamMode?: boolean; scripts?: string[]; extra?: Record<string, any> } = {}) {
  const els = pageElements();
  const calls: Call[] = [];
  const appended: any[] = [];
  const store = new Map<string, string>();

  const fetchImpl = async (url: string, init: any = {}) => {
    const u = new URL(url, "http://localhost");
    const call: Call = {
      method: init.method || "GET",
      path: u.pathname,
      query: u.searchParams,
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers || {},
    };
    calls.push(call);
    const handler = opts.routes?.[`${call.method} ${call.path}`];
    if (!handler) throw new Error(`unexpected fetch ${call.method} ${url}`);
    const reply = typeof handler === "function" ? handler(call) : handler;
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply.body ?? {},
      text: async () => JSON.stringify(reply.body ?? {}),
    };
  };

  const doc = {
    documentElement: { lang: "en" },
    activeElement: null as any,
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    getElementById: (id?: string) => els.get(id ?? "") ?? null,
    createElement: () => makeEl(),
    addEventListener() {},
    removeEventListener() {},
    body: { style: {}, appendChild: (el: any) => void appended.push(el) },
  };
  const ctx: any = {
    console,
    document: doc,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
    navigator: { language: "en-US" },
    fetch: fetchImpl,
    // The confirm sheet replaces the native dialog; reaching for it is a bug.
    confirm: () => {
      throw new Error("confirm() must not be used");
    },
    alert: () => {},
    setTimeout,
    clearTimeout,
    module: undefined,
    exports: undefined,
    ...(opts.extra || {}),
  };
  ctx.window = ctx;
  ctx.location = { href: "" };
  vm.createContext(ctx);
  const src = (opts.scripts ?? PROJECT_SCRIPTS)
    .map((rel) => readFileSync(resolve(ROOT, rel), "utf8"))
    .join("\n");
  vm.runInContext(src, ctx);
  // Top-level `let` bindings: assigned in-context, not as sandbox properties.
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"; TEAM_MODE = ${opts.teamMode ? "true" : "false"}`, ctx);
  ctx.initI18n("en");

  const toastHtml = () => (appended.length ? (appended[appended.length - 1].innerHTML as string) : "");
  return { ctx, els, calls, store, appended, toastHtml };
}

/** Let every pending microtask settle. */
export const drain = () => new Promise((r) => setTimeout(r, 0));

export const PROJECT_ROWS = [
  { id: "website", name: "Website relaunch", description: "Marketing site and docs.\nSecond line.", aliases: ["web", "landing"], status: "active", workspace_id: "personal", layer: "personal", created_at: 1, updated_at: null, count: 12 },
  { id: "trip-rome", name: "Trip to Rome", description: "", aliases: [], status: "active", workspace_id: "company", layer: "company", created_at: 2, updated_at: null, count: 1 },
  { id: "old-app", name: "Old app", description: "Shelved.", aliases: [], status: "archived", workspace_id: "personal", layer: "personal", created_at: 3, updated_at: 4, count: 7 },
];
