/**
 * SH-2 (T-0101.1.3): every dashboard write that changes a memory offers an
 * Undo, or is explicitly allowlisted with a reason. This is a drift guard,
 * not a behavior test — it cannot tell whether a call site's undoToast is
 * wired correctly, only that a write endpoint's own function mentions
 * undoToast or undoMany somewhere in its body, or is named below.
 *
 * Mirrors confirm-sheet-callers.test.ts's approach: walk public/js, not a
 * fixed file list, so a write added in a file nobody thought to list here
 * still gets caught.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const PUBLIC_JS = resolve(ROOT, "public/js");

function listJs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const FILES = listJs(PUBLIC_JS).map((f) => relative(ROOT, f)).sort();

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The write endpoints a dashboard action can undo the user out of. */
const WRITE_ENDPOINTS = [
  "/update",
  "/append",
  "/forget",
  "/status",
  "/capture",
  "/loops/resolve",
  "/due/snooze",
  "/due/clear",
  "/stale/keep",
  "/patterns/resolve",
  "/mcp",
];

/**
 * Every top-level `function name(...) { ... }` (async or not) as
 * `{ name, body }`, body being the source between its own braces. Naive
 * brace counting, the same risk this codebase's other structural scans (this
 * file's sibling confirm-sheet-callers.test.ts) already accept: nested
 * template literals or regex containing braces could confuse it, and none of
 * the files here do that around a fetch call.
 */
function functionBlocks(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length - 1; // position of the opening {
    let depth = 0;
    let end = start;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.push({ name: m[1], body: src.slice(start, end + 1) });
  }
  return out;
}

/**
 * `file:function` pairs allowed to call a write endpoint without their own
 * undoToast/undoMany, and why.
 */
const ALLOWLIST: Record<string, string> = {
  "public/js/memory-crud.js:openDeleteForeverConfirm": "Delete forever is permanent; it is never offered an undo.",
  "public/js/api.js:apiCapture": "a thin POST helper with no toast of its own; its one caller, home.js's submitHome, wires the undo itself (see below).",
  "public/js/home.js:submitHome": "a fresh capture has no earlier version to POST /undo to, so its own Undo action calls /forget directly and shows a second toast saying so, rather than going through undoToast.",
  // Reserved per the spec's own list, for a future call site: share has its
  // own undo (api.js's toggleEntryLayer) and integrations disconnect is
  // recovered from the trash view, not from an undo toast. Neither currently
  // calls one of WRITE_ENDPOINTS, so neither needs an entry above yet.
};

describe("every memory write call site offers undo, or is allowlisted", () => {
  it("walked at least the known write-site files", () => {
    for (const f of ["public/js/memory-crud.js", "public/js/due.js", "public/js/loops.js", "public/js/stale.js", "public/js/patterns.js", "public/js/brief.js", "public/js/home.js", "public/js/api.js"]) {
      expect(FILES, f).toContain(f);
    }
  });

  it("has no stale allowlist entry", () => {
    const stale: string[] = [];
    for (const key of Object.keys(ALLOWLIST)) {
      const [file, fn] = key.split(":");
      const src = stripComments(readFileSync(resolve(ROOT, file), "utf8"));
      const block = functionBlocks(src).find((b) => b.name === fn);
      if (!block || !WRITE_ENDPOINTS.some((ep) => block.body.includes(`\${WORKER_URL}${ep}`))) {
        stale.push(key);
      }
    }
    expect(stale, "allowlist entries that no longer name a real write call site").toEqual([]);
  });

  it("every write call site's function mentions undoToast or undoMany, or is allowlisted", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const raw = readFileSync(resolve(ROOT, file), "utf8");
      const src = stripComments(raw);
      for (const block of functionBlocks(src)) {
        const hit = WRITE_ENDPOINTS.find((ep) => block.body.includes(`\${WORKER_URL}${ep}`));
        if (!hit) continue;
        const key = `${file}:${block.name}`;
        const offersUndo = block.body.includes("undoToast(") || block.body.includes("undoMany(");
        if (!offersUndo && !ALLOWLIST[key]) {
          violations.push(`${key} calls ${hit} without undoToast/undoMany and is not allowlisted`);
        }
      }
    }
    expect(violations, "add an undo toast, or add the site to ALLOWLIST here with a reason").toEqual([]);
  });
});
