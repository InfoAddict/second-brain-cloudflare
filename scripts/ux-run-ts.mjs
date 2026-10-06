#!/usr/bin/env node
// Bundles and runs any UX-I TypeScript entry as plain Node (mirrors scripts/eval-run-ts.mjs).
// Three modules are aliased to local stand-ins (scripts/ux-harness/stubs/), the same minimal set
// vitest.setup.ts already mocks: their real dependency chains reach into cloudflare:workers,
// cloudflare:email and cloudflare:sockets, which exist only inside the Workers runtime.
// Usage: node scripts/ux-run-ts.mjs <entry.ts> [args...]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error("usage: node scripts/ux-run-ts.mjs <entry.ts> [args...]");
  process.exit(2);
}
const outDir = resolve(root, ".ux-harness/bundles");
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
  alias: {
    "agents/mcp": resolve(root, "scripts/ux-harness/stubs/agents-mcp.ts"),
    "cloudflare:sockets": resolve(root, "scripts/ux-harness/stubs/cloudflare-sockets.ts"),
    "@cloudflare/workers-oauth-provider": resolve(root, "scripts/ux-harness/stubs/workers-oauth-provider.ts"),
  },
  external: ["wrangler", "node:*", "@huggingface/transformers", "onnxruntime-*", "sharp", "puppeteer-core"],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});

const child = spawn(process.execPath, ["--enable-source-maps", outfile, ...args], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, SB_EVAL_ROOT: root },
});
child.on("exit", (code) => process.exit(code ?? 0));
