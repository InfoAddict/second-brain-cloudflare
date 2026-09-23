import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("a relocated SB_EVAL_ROOT without eval data", () => {
  it("gives a usage error, not a raw ENOENT, when --json is checked", async () => {
    vi.stubEnv("SB_EVAL_ROOT", mkdtempSync(join(tmpdir(), "no-data-root-")));
    vi.resetModules();
    const cli = await import("./cli");
    expect(() => cli.assertJsonPathAllowed(join(tmpdir(), "r.json"))).toThrow(cli.UsageError);
    expect(() => cli.assertJsonPathAllowed(join(tmpdir(), "r.json"))).toThrow(/SB_EVAL_ROOT/);
  });
});
