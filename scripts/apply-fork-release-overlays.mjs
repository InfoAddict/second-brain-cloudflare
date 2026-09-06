#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FORK_OVERLAY_PATHS = [
  "AI_Instructions/CHATGPT_INSTRUCTIONS.md",
  "public/index.html",
  "docs/dashboard-architecture.md",
  "src/insight/eligibility.ts",
];

function replaceExactlyOnce(text, needle, replacement, path) {
  const first = text.indexOf(needle);
  const last = text.lastIndexOf(needle);
  if (first === -1 || first !== last) {
    throw new Error(`Expected exactly one overlay anchor in ${path}: ${needle}`);
  }
  return text.slice(0, first) + replacement + text.slice(first + needle.length);
}

function overlayChatGptInstructions(text, path) {
  const lines = text.split("\n");
  const indexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith("Tags:") && /Source:\s*chatgpt\./.test(line));
  if (indexes.length !== 1) {
    throw new Error(`Expected exactly one ChatGPT tag line in ${path}`);
  }

  const { line, index } = indexes[0];
  if (line.includes("chatgpt-response") && !line.includes("claude-response")) return text;
  const matches = line.match(/claude-response/g) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Could not safely apply the ChatGPT response-tag overlay in ${path}`);
  }
  lines[index] = line.replace("claude-response", "chatgpt-response");
  return lines.join("\n");
}

function overlayDashboardIndex(text, path) {
  if (text.includes('<script src="js/dashboard-entry-deep-link.js"></script>')) return text;
  const authScript = '    <script src="js/auth.js"></script>';
  return replaceExactlyOnce(
    text,
    authScript,
    `${authScript}\n    <script src="js/dashboard-entry-deep-link.js"></script>`,
    path,
  );
}

function overlayDashboardDocs(text, path) {
  if (!text.includes("`js/auth.js`, `js/dashboard-entry-deep-link.js`, `js/download-app.js`")) {
    text = replaceExactlyOnce(
      text,
      "`js/auth.js`, `js/download-app.js`",
      "`js/auth.js`, `js/dashboard-entry-deep-link.js`, `js/download-app.js`",
      path,
    );
  }
  if (!text.includes("| Dashboard memory deep links | `js/dashboard-entry-deep-link.js` |")) {
    text = replaceExactlyOnce(
      text,
      "| Auth connect / showApp | `js/auth.js` |",
      "| Auth connect / showApp | `js/auth.js` |\n| Dashboard memory deep links | `js/dashboard-entry-deep-link.js` |",
      path,
    );
  }
  if (!text.includes("auth.js → dashboard-entry-deep-link.js → download-app.js")) {
    text = replaceExactlyOnce(
      text,
      "auth.js → download-app.js",
      "auth.js → dashboard-entry-deep-link.js → download-app.js",
      path,
    );
  }
  return text;
}

function overlayInsightTags(text, path) {
  const start = text.indexOf("export const AXIS_TAGS");
  const end = start === -1 ? -1 : text.indexOf("]);", start);
  if (start === -1 || end === -1) {
    throw new Error(`Could not find AXIS_TAGS in ${path}`);
  }
  const block = text.slice(start, end);
  if (block.includes('"chatgpt-response"')) return text;
  const patched = replaceExactlyOnce(
    block,
    '"cursor-response"',
    '"cursor-response", "chatgpt-response"',
    path,
  );
  return text.slice(0, start) + patched + text.slice(end);
}

export function applyForkOverlayText(path, text) {
  switch (path) {
    case "AI_Instructions/CHATGPT_INSTRUCTIONS.md":
      return overlayChatGptInstructions(text, path);
    case "public/index.html":
      return overlayDashboardIndex(text, path);
    case "docs/dashboard-architecture.md":
      return overlayDashboardDocs(text, path);
    case "src/insight/eligibility.ts":
      return overlayInsightTags(text, path);
    default:
      throw new Error(`Unknown fork overlay path: ${path}`);
  }
}

export function applyForkReleaseOverlays(root = process.cwd()) {
  const planned = FORK_OVERLAY_PATHS.map((path) => {
    const absolute = resolve(root, path);
    const before = readFileSync(absolute, "utf8");
    return { absolute, path, before, after: applyForkOverlayText(path, before) };
  });

  for (const file of planned) {
    if (file.after !== file.before) writeFileSync(file.absolute, file.after);
  }
  return planned.filter((file) => file.after !== file.before).map((file) => file.path);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const changed = applyForkReleaseOverlays();
  console.log(changed.length > 0
    ? `Applied fork release overlays: ${changed.join(", ")}`
    : "Fork release overlays already applied.");
}
