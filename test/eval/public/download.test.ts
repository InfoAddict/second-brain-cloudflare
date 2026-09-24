// Opt-in: downloads the real datasets (SciFact ~3 MB, allenai release, MIRACL-ja ~1 GB) into .eval-cache/public/.
// EVAL_PUBLIC_DOWNLOAD=1 npx vitest run test/eval/public/download.test.ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadNeutralCorpus, PUBLIC_CORPORA } from "./neutral";

const root = resolve(import.meta.dirname, "../../..");
const sha = (id: string, f: string) => createHash("sha256").update(readFileSync(resolve(root, ".eval-cache/public", id, f))).digest("hex");

// Derived-file hashes pin both the download and the seeded sampling (Sep 23, 2026 run; scifact re-pinned to the allenai release).
const EXPECTED = {
  scifact: { docs: 5183, queries: 693, corpus: "98c19f6343a102c7e806c135abb871ce17b9b617c0456c0e4691d64e376282d8" },
  "miracl-ja": { docs: 13498, queries: 860, corpus: "f96cab21f7c9057f618149722f0df3f1749e788a25eb7f2ac0a12be84b8be9b5" },
} as const;

const enabled = !["", "0", "false"].includes((process.env.EVAL_PUBLIC_DOWNLOAD ?? "").toLowerCase());

describe.skipIf(!enabled)("real public corpora", () => {
  for (const id of Object.keys(PUBLIC_CORPORA)) {
    it(`${id}: downloads, verifies checksums, parses, and reproduces the pinned sample`, () => {
      const run = spawnSync("node", ["scripts/eval-fetch-public.mjs", id], { cwd: root, encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      const cfg = PUBLIC_CORPORA[id];
      const spec = loadNeutralCorpus({ id, dir: resolve(root, ".eval-cache/public", id), category: cfg.category, maxDocs: cfg.maxDocs, maxQueries: cfg.maxQueries });
      const want = EXPECTED[id as keyof typeof EXPECTED];
      expect(spec.entries).toHaveLength(want.docs);
      expect(spec.queries).toHaveLength(want.queries);
      expect(sha(id, "corpus.jsonl")).toBe(want.corpus);
      if (id === "miracl-ja") {
        const { counts } = JSON.parse(readFileSync(resolve(root, ".eval-cache/public", id, "MANIFEST.json"), "utf8"));
        expect(counts.lengthAuc).toBeGreaterThan(0.35); // was 0.773 before length-matching
        expect(counts.lengthAuc).toBeLessThan(0.65);
      }
    }, 30 * 60_000);
  }
});
