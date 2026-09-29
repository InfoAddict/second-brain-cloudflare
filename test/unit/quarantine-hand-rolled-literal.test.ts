/**
 * Codex cross-vendor review, T-0102, director follow-up MINOR (round 2 re-review): four readers
 * (prompt-capsule/build.ts, standing/cache.ts, brief/compute.ts, memory/validity.ts) hid a held
 * row by hand-rolling their own `quarantine:`-prefix LIKE/instr() check instead of the shared
 * exact-match NOT_HELD_SQL/notHeldSqlFor (src/quarantine/tags.ts) -- the same class of bug
 * finding 1 fixed for isHeld/heldReason/withHold themselves, just re-introduced piecemeal at
 * every call site that read the tags column directly.
 *
 * This is the structural guard against a fifth one turning up the same way: any string literal
 * (single-quoted, double-quoted or backtick) under src/ that names the `quarantine:` prefix
 * directly, outside the one file that owns the format, is a violation -- it should read tags
 * through NOT_HELD_SQL, notHeldSqlFor, notHeldInstrSql, or QUARANTINE_TAG_PREFIX (a reference to
 * the shared constant, not a duplicated literal).
 *
 * Round 4 re-review MINOR ("make the ban real, all the way"): the round 3 scanner only looked
 * inside SQL template-literal spans, and only matched the interpolation form under its own exact
 * name. A hand-rolled check can just as easily live in a plain quoted string or a .bind()
 * argument, spell the LIKE pattern as '%quarantine:%' (no quote directly before the prefix), space
 * out the interpolation (`${ QUARANTINE_TAG_PREFIX }`), or import the constant under an alias.
 * This scanner strips comments (the one place "quarantine:" legitimately appears in prose, this
 * file and quarantine/tags.ts's own docs included) and then searches the WHOLE remaining file
 * text, not just template-literal spans -- every quote form and every call argument along with it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { templateSpans } from "../../scripts/check-scope.mjs";

const ROOT = join(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");

/** The one file allowed to spell the literal `quarantine:` prefix: it is the format's own owner,
 * and every other reader is expected to import from it instead. */
const OWNER_FILE = "src/quarantine/tags.ts";

/** Strips `//` and `/* *\/` comments, replacing their content with spaces of the same length so
 * every offset into the result still points at the same place in the original text. Naive
 * relative to a real lexer -- it does not know about string literals, so a "//" or "/*" INSIDE one
 * would be misread the same way -- but nothing under src/ puts either inside a quarantine:-naming
 * literal, and the alternative (a hand-rolled check hiding in a comment-adjacent false positive)
 * is the safer failure direction for a guard whose whole job is not missing one. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** This file's own local name for QUARANTINE_TAG_PREFIX, following an `as` alias if the import
 * uses one. Falls back to the real name, so a file with no such import simply never matches an
 * interpolation that could not compile anyway. */
function aliasFor(text: string): string {
  const m = /QUARANTINE_TAG_PREFIX\s+as\s+(\w+)/.exec(text);
  return m ? m[1] : "QUARANTINE_TAG_PREFIX";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Both banned forms, resolved for one file: the bare literal (any quote form, any character
 * immediately before it -- '%quarantine:%' included) and the interpolation (either name, any
 * amount of whitespace inside the braces). */
function patternFor(alias: string): RegExp {
  const names = new Set(["QUARANTINE_TAG_PREFIX", alias]);
  const interpolations = [...names].map((n) => `\\$\\{\\s*${escapeRegExp(n)}\\s*\\}`).join("|");
  return new RegExp(`quarantine:|${interpolations}`, "g");
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

interface Hit { file: string; line: number; snippet: string }

/** The scan, over an explicit file list -- real src/ files by default (scan()), or a synthetic
 * one the "fails loudly" test below injects, so that test exercises this exact function rather
 * than only its own dependency. */
function scanFiles(files: readonly { file: string; text: string }[]): Hit[] {
  const hits: Hit[] = [];
  for (const { file, text } of files) {
    if (file === OWNER_FILE) continue;
    // Round 3 re-review MINOR: a file this lexer cannot parse (unbalanced backticks) used to be
    // silently skipped -- exactly the failure mode that would let a hand-rolled literal inside an
    // unparseable file hide from this guard forever. Fail loudly instead: the guard's whole
    // premise is that every file in src/ was actually inspected.
    const spans = templateSpans(text) as unknown as { balanced?: boolean };
    if (spans.balanced === false) {
      throw new Error(`quarantine-hand-rolled-literal scan: ${file} has unbalanced template literals -- cannot verify it has no hand-rolled quarantine: check`);
    }
    const stripped = stripComments(text);
    const pattern = patternFor(aliasFor(text));
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(stripped)) !== null) {
      const line = text.slice(0, m.index).split("\n").length;
      hits.push({ file, line, snippet: stripped.slice(Math.max(0, m.index - 20), m.index + 30).replace(/\s+/g, " ").trim() });
    }
  }
  return hits;
}

function scan(): Hit[] {
  const files = [...walk(SRC)].map((path) => ({
    file: relative(ROOT, path).replace(/\\/g, "/"),
    text: readFileSync(path, "utf8"),
  }));
  return scanFiles(files);
}

describe("no hand-rolled quarantine: literal outside quarantine/tags.ts", () => {
  it("finds nothing (the scan is not silently empty: it inspects real files in src/)", () => {
    // Vacuous-success guard: quarantine/tags.ts itself is excluded, so confirm the scanner still
    // walks a meaningful slice of src/ by checking it can see at least one real file.
    const files = [...walk(SRC)];
    expect(files.length).toBeGreaterThan(100);
  });

  it("every string literal under src/ reads tags through the shared helper, not a hand-rolled quarantine: literal", () => {
    const hits = scan();
    expect(hits).toEqual([]);
  });

  it("catches every banned form: a plain literal with no quote directly before the prefix, a spaced-out interpolation, an aliased import, and a .bind() argument", () => {
    const noQuoteBeforePrefix = `tags NOT LIKE '%quarantine:instruction%'`;
    const spacedInterpolation = "tags NOT LIKE '%\"${ QUARANTINE_TAG_PREFIX }instruction\"%'";
    const aliasedImportSite = `import { QUARANTINE_TAG_PREFIX as QTP } from "../quarantine/tags";\nconst sql = \`tags NOT LIKE '%\${QTP}instruction%'\`;`;
    const bindArgument = `stmt.bind('%"quarantine:hidden"%')`;
    const blessedForm = "AND ${NOT_HELD_SQL}";

    expect(scanFiles([{ file: "a.ts", text: noQuoteBeforePrefix }])).toHaveLength(1);
    expect(scanFiles([{ file: "b.ts", text: spacedInterpolation }])).toHaveLength(1);
    expect(scanFiles([{ file: "c.ts", text: aliasedImportSite }])).toHaveLength(1);
    expect(scanFiles([{ file: "d.ts", text: bindArgument }])).toHaveLength(1);
    expect(scanFiles([{ file: "e.ts", text: blessedForm }])).toHaveLength(0);
  });

  it("ignores a comment that merely explains the prefix in prose", () => {
    const prose = `// a 3.7 tag like quarantine:2020 is an ordinary user tag\nconst x = 1;`;
    expect(scanFiles([{ file: "f.ts", text: prose }])).toHaveLength(0);
  });

  it("fails loudly, not silently, on a file the lexer cannot parse", () => {
    // Round 4 re-review NIT: calls the real scanFiles(), not just templateSpans() in isolation,
    // so this proves scan()'s own throw path, not merely its dependency's balanced flag.
    const unbalanced = "const sql = `SELECT * FROM entries WHERE id = ?;";
    expect(() => scanFiles([{ file: "g.ts", text: unbalanced }])).toThrow(/unbalanced template literals/);
  });
});
