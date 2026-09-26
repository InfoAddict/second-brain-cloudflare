import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every temp dir a test makes (in a worker, or in a CLI or wrangler process a test spawns) lands under one
// per-run root, because TMPDIR is inherited. The run fails if anything is left in it: a leak is a bug in the
// test that made it, and /tmp is a small tmpfs that a leaking suite can fill.
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "sb-vitest-"));
  process.env.TMPDIR = root;
  process.env.SB_TEST_TMP_ROOT = root;
  return () => {
    const left = readdirSync(root);
    rmSync(root, { recursive: true, force: true });
    if (left.length) throw new Error(`the test run leaked ${left.length} temp entries (first: ${left.slice(0, 10).join(", ")}); a test or helper made a temp dir it never removed`);
  };
}
