#!/usr/bin/env node
// UX-I: boots the real Worker and dashboard offline, no Cloudflare account of any kind.
// UX_BRAIN picks which seeded brain to run against (default: "default", an empty brain that
// initializeDatabase creates fresh); UX_PORT picks the port (default 8788).
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const child = spawn(process.execPath, [resolve(root, "scripts/ux-run-ts.mjs"), "scripts/ux-harness/dev-server.ts"], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
