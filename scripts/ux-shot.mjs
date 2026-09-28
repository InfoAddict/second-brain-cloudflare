#!/usr/bin/env node
// UX-I: capture one named screen or state on demand. See scripts/ux-harness/shot.ts for usage.
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const child = spawn(process.execPath, [resolve(root, "scripts/ux-run-ts.mjs"), "scripts/ux-harness/shot.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
