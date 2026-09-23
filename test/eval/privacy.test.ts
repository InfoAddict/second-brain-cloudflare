import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  REPO_ROOT, assertIgnored, dataAllowlistViolations, ignoreRuleViolations, isAllowedDataFile, scanText, scanTracked, trackedButIgnored, trackedFiles,
} from "./privacy";

// Violation samples are assembled at runtime so this tracked file never trips its own scan.
const AT = "@";
const GMAIL = `dana.k${AT}gmail.com`;
const N = "5309";
const UUID = ["3f2b8c1e", "9d4a", "4e7b", "8a15", "6c0d2f9e7b31"].join("-");

// Markers are assembled at runtime so this file never contains one whole.
const CANARY = ["SB_EVAL", "CANARY", "A1B2C3D4"].join("_");

/** A throwaway git repo with the real .gitignore, for deliberate violations. */
function sandbox(files: Record<string, string | Buffer> = {}) {
  const root = mkdtempSync(join(tmpdir(), "privacy-"));
  const run = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  run("init", "-q");
  copyFileSync(resolve(REPO_ROOT, ".gitignore"), join(root, ".gitignore"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  run("add", "-A", "-f");
  return { root, run };
}

describe("guard 1: ignore rules", () => {
  it("hold in this repo", () => expect(ignoreRuleViolations()).toEqual([]));

  it("fire when a rule is dropped", () => {
    const { root } = sandbox();
    writeFileSync(join(root, ".gitignore"), "*.sql\n");
    expect(ignoreRuleViolations(root).length).toBeGreaterThan(3);
  });

  it("fire when the public download dir is re-included", () => {
    const { root } = sandbox();
    writeFileSync(join(root, ".gitignore"), ".eval-cache/*\n!.eval-cache/public/\n");
    expect(ignoreRuleViolations(root)).toContain(".eval-cache/public/scifact/corpus.jsonl");
  });

  it("no tracked file is also ignored", () => expect(trackedButIgnored()).toEqual([]));
});

describe("guard 2: tracked-data allowlist", () => {
  it("covers every currently tracked file under test/eval/data", () => {
    expect(dataAllowlistViolations(trackedFiles())).toEqual([]);
    expect(trackedFiles().filter(isAllowedDataFile).length).toBeGreaterThanOrEqual(4);
  });

  it("accepts exactly the committed shapes", () => {
    for (const f of [
      "test/eval/data/core/needles.jsonl", "test/eval/data/core/edges.jsonl", "test/eval/data/core/queries.jsonl", "test/eval/data/core/manifest.json",
      "test/eval/data/core/replay.bge-small-en-v1.5.jsonl.gz", "test/eval/data/baselines/core-1k.bge-small-en-v1.5.json",
    ]) expect(isAllowedDataFile(f), f).toBe(true);
  });

  it("rejects every other shape", () => {
    for (const f of [
      "test/eval/data/core/private-notes.jsonl", "test/eval/data/core/replay.x.jsonl", "test/eval/data/core/sub/queries.jsonl",
      "test/eval/data/queries.jsonl", "test/eval/data/public/scifact/corpus.jsonl", "test/eval/data/baselines/x.jsonl",
      "test/eval/data/baselines/sub/x.json", "test/eval/data/brain.sqlite", "test/eval/data/captured-queries.jsonl",
    ]) expect(isAllowedDataFile(f), f).toBe(false);
  });

  it("fires on a deliberate violation", () => {
    const { root } = sandbox({ "test/eval/data/core/brain-export.jsonl": "{}", "test/eval/data/core/needles.jsonl": "{}" });
    expect(dataAllowlistViolations(trackedFiles(root))).toEqual(["test/eval/data/core/brain-export.jsonl"]);
  });
});

describe("guard 3: canary and export-shape scan", () => {
  it("finds nothing in what git tracks now", () => expect(scanTracked()).toEqual([]));

  const rules = (text: string, heuristics = true) => scanText("f", text, heuristics).map(f => f.rule);

  it("flags a canary anywhere, even outside the eval scope", () => {
    expect(rules(`note ${CANARY} here`, false)).toEqual(["canary"]);
    expect(rules("SB_EVAL_CANARY_", false)).toEqual([]);
  });

  it("flags emails outside reserved domains only", () => {
    expect(rules(`mail ${GMAIL} now`)).toEqual(["email"]);
    expect(rules(`mail dana${AT}corp.acme.io`)).toEqual(["email"]);
    expect(rules("a@example.com b@x.example.org c@host.test d@localhost recall@10")).toEqual([]);
  });

  it("flags phone numbers but not the fictional 555-01xx block or ids", () => {
    for (const p of [`call 415-867-${N}`, `call (415) 867-${N}`, `call +1 415 867 ${N}`, `call +44 20 7946 ${"0958"}`]) expect(rules(p), p).toEqual(["phone"]);
    expect(rules("call 555-0142 or 415-555-0142 or INV-88213 at 2026-09-23 ts 1790000000000")).toEqual([]);
  });

  it("flags production-format entry ids (v4 uuids)", () => {
    expect(rules(`id ${UUID}`)).toEqual(["entry-id"]);
    expect(rules("id n-id-001 and 3f2b8c1e-9d4a-1e7b-8a15-6c0d2f9e7b31")).toEqual([]);
  });

  it("flags credential shapes", () => {
    expect(rules(`token ${["ghp", "abcdefghijklmnopqrstuvwx"].join("_")}`)).toEqual(["credential"]);
    expect(rules(`Authorization: Bearer ${"a".repeat(30)}`)).toEqual(["credential"]);
  });

  it("fires on tracked violations, including inside a gzip replay cache", () => {
    const { root } = sandbox({
      "test/eval/data/core/needles.jsonl": `{"content":"reach me at ${GMAIL}"}\n`,
      "test/eval/data/core/replay.m.jsonl.gz": gzipSync(`{"text":"${CANARY}"}\n`),
      "src/other.ts": `// ${CANARY}\n`,
      "src/fixture.ts": `const id = '${UUID}'; // outside eval scope: heuristics off\n`,
    });
    const found = scanTracked(root).map(f => `${f.file}:${f.rule}`).sort();
    expect(found).toEqual(["src/other.ts:canary", "test/eval/data/core/needles.jsonl:email", "test/eval/data/core/replay.m.jsonl.gz:canary"]);
  });
});

describe("guard 4: output paths", () => {
  it("accepts ignored and outside-repo paths", () => {
    expect(() => assertIgnored(".eval-cache/results/r.json")).not.toThrow();
    expect(() => assertIgnored("docs/superpowers/eval-results/r.json")).not.toThrow();
    expect(() => assertIgnored(join(mkdtempSync(join(tmpdir(), "outside-")), "x.json"))).not.toThrow();
  });

  it("refuses non-ignored paths, including the golden data directory", () => {
    for (const p of ["package.json", "r.json", "test/eval/data/core/private-notes.jsonl", "test/eval/data/baselines/x.json", "test/eval/results.json"]) {
      expect(() => assertIgnored(p), p).toThrow(/not git-ignored/);
    }
  });

  it("refuses an ignored path that git already tracks", () => {
    const { root } = sandbox({ ".eval-cache/leaked.json": "{}" });
    expect(() => assertIgnored(".eval-cache/leaked.json", root)).toThrow(/tracked/);
  });

  it("refuses a symlink from an ignored directory into a tracked one", () => {
    const { root } = sandbox({ "test/eval/data/core/needles.jsonl": "{}" });
    mkdirSync(join(root, ".eval-cache"), { recursive: true });
    symlinkSync(join(root, "test/eval/data/core"), join(root, ".eval-cache/link"));
    expect(() => assertIgnored(".eval-cache/link/out.json", root)).toThrow(/not git-ignored/);
  });
});
