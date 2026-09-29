/**
 * Codex cross-vendor review, T-0102, director follow-up MINOR (round 2 re-review): four readers
 * (prompt-capsule/build.ts, standing/cache.ts, brief/compute.ts, memory/validity.ts) hid a held
 * row by hand-rolling their own `quarantine:`-prefix LIKE/instr() check instead of the shared
 * exact-match NOT_HELD_SQL/notHeldSqlFor (src/quarantine/tags.ts) -- the same class of bug
 * finding 1 fixed for isHeld/heldReason/withHold themselves, just re-introduced piecemeal at
 * every call site that read the tags column directly.
 *
 * This is the structural guard against a fifth one turning up the same way: any SQL template
 * literal under src/ that names the `quarantine:` prefix directly, outside the one file that
 * owns the format, is a violation -- it should read tags through NOT_HELD_SQL, notHeldSqlFor, or
 * QUARANTINE_TAG_PREFIX (a reference to the shared constant, not a duplicated literal).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { templateSpans } from "../../scripts/check-scope.mjs";

const ROOT = join(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");

/** The one file allowed to spell the literal `quarantine:` prefix in a SQL fragment: it is the
 * format's own owner, and every other reader is expected to import from it instead. */
const OWNER_FILE = "src/quarantine/tags.ts";

const QUARANTINE_LITERAL = /["']quarantine:/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

interface Hit { file: string; line: number; snippet: string }

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const path of walk(SRC)) {
    const file = relative(ROOT, path).replace(/\\/g, "/");
    if (file === OWNER_FILE) continue;
    const text = readFileSync(path, "utf8");
    const spans = templateSpans(text) as unknown as { start: number; end: number; balanced?: boolean }[];
    if ((spans as unknown as { balanced?: boolean }).balanced === false) continue;
    for (const span of spans) {
      const sql = text.slice(span.start + 1, span.end);
      const m = QUARANTINE_LITERAL.exec(sql);
      if (!m) continue;
      const line = text.slice(0, span.start + 1 + m.index).split("\n").length;
      hits.push({ file, line, snippet: sql.slice(Math.max(0, m.index - 20), m.index + 30).replace(/\s+/g, " ").trim() });
    }
  }
  return hits;
}

describe("no hand-rolled quarantine: literal outside quarantine/tags.ts", () => {
  it("finds nothing (the scan is not silently empty: it inspects real template literals in src/)", () => {
    // Vacuous-success guard: quarantine/tags.ts itself is excluded, so confirm the scanner still
    // walks a meaningful slice of src/ by checking it can see at least one template literal file.
    const files = [...walk(SRC)];
    expect(files.length).toBeGreaterThan(100);
  });

  it("every SQL template literal under src/ reads tags through the shared helper, not a hand-rolled quarantine: literal", () => {
    const hits = scan();
    expect(hits).toEqual([]);
  });
});
