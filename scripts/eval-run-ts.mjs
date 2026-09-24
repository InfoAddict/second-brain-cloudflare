#!/usr/bin/env node
// Bundles a test/eval TypeScript entry with esbuild and runs it under node.
// Usage: node scripts/eval-run-ts.mjs <entry.ts> [args...]
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error("usage: node scripts/eval-run-ts.mjs <entry.ts> [args...]");
  process.exit(2);
}
const outDir = resolve(root, ".eval-cache/bundles");
mkdirSync(outDir, { recursive: true });
const outfile = resolve(outDir, `${basename(entry, ".ts")}.mjs`);
await build({
  entryPoints: [resolve(root, entry)],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: "inline",
  logLevel: "error",
  // The local embedding runtime is native (onnxruntime-node) and loads from node_modules at run time.
  external: ["wrangler", "node:*", "@huggingface/transformers", "onnxruntime-*", "sharp"],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
const run = spawnSync(process.execPath, ["--enable-source-maps", outfile, ...args], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, SB_EVAL_ROOT: root },
});
process.exit(run.status ?? 2);
