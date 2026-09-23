import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("SB_EVAL_ROOT is honored consistently", () => {
  it("lets ReplayStore and replayPaths agree on a root outside the repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-root-"));
    mkdirSync(join(root, ".eval-cache/replay"), { recursive: true });
    mkdirSync(join(root, "test/eval/data/core"), { recursive: true });
    writeFileSync(join(root, ".eval-cache/replay/m.jsonl"), "");
    vi.stubEnv("SB_EVAL_ROOT", root);
    vi.resetModules();
    const { replayPaths } = await import("./corpora");
    const { ReplayStore } = await import("./ai-replay");
    const paths = replayPaths("@cf/x/m");
    expect(paths.write).toBe(join(root, ".eval-cache/replay/m.jsonl"));
    expect(() => new ReplayStore(paths.read, paths.write)).not.toThrow();
  });

  it("replayPaths.read lists only cache files that exist, so an empty read means nothing is recorded", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-root-"));
    mkdirSync(join(root, ".eval-cache/replay"), { recursive: true });
    mkdirSync(join(root, "test/eval/data/core"), { recursive: true });
    vi.stubEnv("SB_EVAL_ROOT", root);
    vi.resetModules();
    const { replayPaths } = await import("./corpora");
    expect(replayPaths("@cf/x/m").read).toEqual([]);
    writeFileSync(join(root, ".eval-cache/replay/m.jsonl"), "");
    expect(replayPaths("@cf/x/m").read).toEqual([join(root, ".eval-cache/replay/m.jsonl")]);
    writeFileSync(join(root, "test/eval/data/core/replay.m.jsonl.gz"), "");
    expect(replayPaths("@cf/x/m").read).toEqual([join(root, "test/eval/data/core/replay.m.jsonl.gz"), join(root, ".eval-cache/replay/m.jsonl")]);
  });
});
