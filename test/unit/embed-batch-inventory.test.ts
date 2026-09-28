/**
 * Budget auditor R20 (T-0089.4.2, T-0089.5.9): every direct `upsertEntryVectors` call site must
 * pass `batchEmbeds: true`, or the row's chunks are re-embedded one AI call each — fine for a
 * handful of chunks, but a single Release of a 128 KB note alone costs roughly one call per
 * chunk (measured at 97 for one note), which repeated across a night's releases blew the
 * Workers Free 1,000-subrequest ceiling. embedMany (batchEmbeds's own path) costs the same one
 * call as an individual embed() for the common few-chunk case, so there is no reason not to
 * batch — the one exemption below is content that can never reach this size in the first place.
 *
 * A writer added here without `batchEmbeds: true`, or an entry in EXEMPT with a stated reason,
 * is the bug class R20 exists to catch.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

const FILES = [
  "src/capture/store.ts",
  "src/memory/trash.ts",
  "src/memory/undo.ts",
  "src/vectorize/pending.ts",
];

/** Direct call sites, excluding upsertEntryVectors' own definition (`export async function
 * upsertEntryVectors(`), keyed by file:line of the line the call starts on. */
function findCallSites(): { file: string; line: number; text: string }[] {
  const sites: { file: string; line: number; text: string }[] = [];
  for (const file of FILES) {
    const lines = readFileSync(resolve(ROOT, file), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/\bupsertEntryVectors\(/.test(lines[i])) continue;
      if (/^export (async )?function upsertEntryVectors\(/.test(lines[i])) continue;
      // The call may wrap onto the next line (src/vectorize/pending.ts) — batchEmbeds can land
      // on either, so the window is this line plus the next.
      sites.push({ file, line: i + 1, text: `${lines[i]}\n${lines[i + 1] ?? ""}` });
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const EXEMPT: { file: string; line: number; why: string }[] = [
  {
    file: "src/capture/store.ts", line: 66,
    why: "storeEntry's own create-time embed. A held write never reaches storeEntry (class A takes the holdStatements batch instead), so the only content that lands here is already under the scorer's 32 KB budget — too few chunks for batching to matter.",
  },
];

describe("every direct upsertEntryVectors call site passes batchEmbeds, or is exempted with a reason", () => {
  it("matches the exempt list exactly for the ones that don't", () => {
    const sites = findCallSites();
    const unbatched = sites.filter(s => !/batchEmbeds:\s*true/.test(s.text));
    const actual = unbatched.map(s => `${s.file}:${s.line}`).sort();
    const expected = EXEMPT.map(s => `${s.file}:${s.line}`).sort();
    expect(actual).toEqual(expected);
  });

  it("finds more than the exempt list alone (vacuous-success guard)", () => {
    const sites = findCallSites();
    expect(sites.length).toBeGreaterThan(EXEMPT.length);
  });
});
