#!/usr/bin/env node
// UX-I: run all four chat walkthroughs (spec section 6.4) against fresh local brains, no
// Cloudflare account of any kind. See scripts/ux-harness/chat-walkthroughs/run-all.ts.
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const child = spawn(process.execPath, [resolve(root, "scripts/ux-run-ts.mjs"), "scripts/ux-harness/chat-walkthroughs/run-all.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
