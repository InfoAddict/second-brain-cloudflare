import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// #348 trip-wire. saveIntegration is create-or-replace: it writes whatever
// record the caller holds, so calling it from a sync that held that record
// across awaited work reverts anything that landed in between. Partial updates
// must go through updateIntegration (framework.ts), which re-reads at save time.
// This exists to fail LATER, at a new call site.

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return walk(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}

const allSrcFiles = walk("src");
const CALL = /\bsaveIntegration\(/;

describe("integration record writers", () => {
  it("saveIntegration is only called by the framework and the connect route", () => {
    const offenders = allSrcFiles.filter((f) => {
      if (f.endsWith("integrations/framework.ts")) return false; // definition + updateIntegration
      if (f.endsWith("routes/integrations.ts")) return false;    // connect's create-or-replace, checked below
      return CALL.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("the integrations route calls it exactly once (connect); layer and the rest use updateIntegration", () => {
    const routeSrc = readFileSync("src/routes/integrations.ts", "utf8");
    expect(routeSrc.match(/\bsaveIntegration\(/g) ?? []).toHaveLength(1);
  });

  it("the scan sees the provider files it is meant to police", () => {
    // Guards the walk itself: an empty or mis-rooted file list would pass vacuously.
    for (const name of ["notion", "calendar", "email", "mirror"]) {
      expect(allSrcFiles.some((f) => f.endsWith(`integrations/${name}.ts`))).toBe(true);
    }
  });
});
