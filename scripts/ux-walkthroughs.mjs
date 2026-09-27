#!/usr/bin/env node
// UX-I: runs the map's scripted dashboard journeys (W1 onward) against a real local Worker and a
// real headless Chrome, no Cloudflare account. Screenshots and index.md land under
// docs/superpowers/screenshots/v4/harness/<run-id>/ (see scripts/ux-harness/screenshots.ts).
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const child = spawn(process.execPath, [resolve(root, "scripts/ux-run-ts.mjs"), "scripts/ux-harness/walkthroughs/run-all.ts"], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
