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
 *
 * Round 5 re-review MINOR ("make the ban real, all the way, again"): a hand-rolled check can also
 * be assembled at a distance -- string concatenation (JS `+`, SQL `||`) can spell "quarantine:"
 * without that exact substring ever appearing whole, a namespace import (`import * as Q from
 * ".../quarantine/tags"` then `Q.QUARANTINE_TAG_PREFIX`) sidesteps the plain-name check, and a
 * local rebinding (`const MY_PREFIX = QUARANTINE_TAG_PREFIX`) creates a new name entirely. And the
 * comment stripper itself had a real gap: it blanked the REST OF THE LINE after any "//", even one
 * that was only ever text inside a string (a URL, say) -- silently eating a real hit that
 * happened to follow one on the same line. All fixed below.
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

/**
 * Strips `//` and `/* *\/` comments down to spaces, preserving every other character (offsets
 * into the result still point at the same place in the original text, so line numbers stay
 * correct). A small string-aware tokenizer, not a regex sweep (round 5 re-review MINOR): a naive
 * `\/\/[^\n]*` blanks the rest of the line the moment it sees "//" ANYWHERE, string literals
 * included -- a URL inside a quoted string ate everything after it on the same line, comment or
 * not. This walks the text tracking whether it is inside a single, double or backtick-quoted
 * string (respecting backslash escapes) and only treats "//" or "/*" as a comment start outside
 * of one.
 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < n) { out += text[i] + text[i + 1]; i += 2; continue; }
        out += text[i] === "\n" ? "\n" : text[i];
        i++;
      }
      if (i < n) { out += text[i]; i++; }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; }
      if (i < n) { out += "  "; i += 2; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Repeatedly collapses adjacent quoted-literal concatenation -- SQL's `'A' || 'B'` and JS's
 * `"A" + "B"` -- into one literal, `'AB'` / `"AB"` (round 5 re-review MINOR: `'quarantine' || ':'`
 * never spells the banned substring whole in either piece alone). Runs to a fixed point, so a
 * chain of three or more pieces folds all the way down, not just the first adjacent pair.
 */
function foldConcatenation(text: string): string {
  let prev: string;
  do {
    prev = text;
    text = text
      .replace(/'([^'\\]*)'\s*\|\|\s*'([^'\\]*)'/g, (_m, a: string, b: string) => `'${a}${b}'`)
      .replace(/"([^"\\]*)"\s*\+\s*"([^"\\]*)"/g, (_m, a: string, b: string) => `"${a}${b}"`);
  } while (text !== prev);
  return text;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every local name this file's own source could use to reach QUARANTINE_TAG_PREFIX without
 * spelling it: an `as` import alias, a namespace import's own qualified access
 * (`Q.QUARANTINE_TAG_PREFIX`), and any local `const` rebound to one of those (round 5 re-review
 * MINOR), traced to a fixed point so a rebinding of a rebinding still resolves. `bare` are plain
 * identifiers (matched standalone or interpolated); `qualified` are dotted accesses (matched the
 * same way, as a whole).
 */
function knownNames(text: string): { bare: Set<string>; qualified: Set<string> } {
  const bare = new Set<string>(["QUARANTINE_TAG_PREFIX"]);
  const qualified = new Set<string>();

  for (const m of text.matchAll(/QUARANTINE_TAG_PREFIX\s+as\s+(\w+)/g)) bare.add(m[1]);
  for (const m of text.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+["'][^"']*quarantine\/tags["']/g)) {
    qualified.add(`${m[1]}.QUARANTINE_TAG_PREFIX`);
  }

  let changed = true;
  while (changed) {
    changed = false;
    const known = [...bare, ...qualified].map(escapeRegExp).join("|");
    const re = new RegExp(`const\\s+(\\w+)\\s*=\\s*(?:${known})\\b`, "g");
    for (const m of text.matchAll(re)) {
      if (!bare.has(m[1])) { bare.add(m[1]); changed = true; }
    }
  }
  return { bare, qualified };
}

/** Every banned form, resolved for one file: the bare literal (any quote form, any character
 * immediately before it -- '%quarantine:%' included, concatenation already folded away by the
 * caller), the interpolation (any known name, any whitespace inside the braces), and a known
 * name directly adjacent to `+` or `||` (concatenation involving the constant ITSELF, which
 * folding cannot catch since the other side is not a literal -- `"%" + QUARANTINE_TAG_PREFIX`). */
function patternFor(names: { bare: Set<string>; qualified: Set<string> }): RegExp {
  const all = [...names.bare, ...names.qualified].map(escapeRegExp);
  const interpolations = all.map((n) => `\\$\\{\\s*${n}\\s*\\}`).join("|");
  const concatenation = all.map((n) => `(?:\\+|\\|\\|)\\s*${n}\\b|\\b${n}\\s*(?:\\+|\\|\\|)`).join("|");
  return new RegExp(`quarantine:|${interpolations}|${concatenation}`, "g");
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
    const stripped = foldConcatenation(stripComments(text));
    const pattern = patternFor(knownNames(text));
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

  it("catches SQL and JS concatenation that spells the prefix without the whole substring ever appearing (round 5 re-review MINOR)", () => {
    const sqlConcat = `const sql = \`tags LIKE 'quarantine' || ':instruction%'\`;`;
    const jsConcatWithConstant = `const like = "%" + QUARANTINE_TAG_PREFIX;`;
    expect(scanFiles([{ file: "h.ts", text: sqlConcat }])).toHaveLength(1);
    expect(scanFiles([{ file: "i.ts", text: jsConcatWithConstant }])).toHaveLength(1);
  });

  it("catches a namespace-qualified import and a locally rebound constant (round 5 re-review MINOR)", () => {
    const namespaced = `import * as Q from "../quarantine/tags";\nconst sql = \`tags LIKE '%\${Q.QUARANTINE_TAG_PREFIX}instruction%'\`;`;
    const rebound = `import { QUARANTINE_TAG_PREFIX } from "../quarantine/tags";\nconst MY_PREFIX = QUARANTINE_TAG_PREFIX;\nconst sql = \`tags LIKE '%\${MY_PREFIX}instruction%'\`;`;
    expect(scanFiles([{ file: "j.ts", text: namespaced }])).toHaveLength(1);
    expect(scanFiles([{ file: "k.ts", text: rebound }])).toHaveLength(1);
  });

  it("does not lose a real hit that follows a // inside an earlier string on the same line (round 5 re-review MINOR)", () => {
    const urlThenHit = `const u = "https://example.com"; const sql = \`tags LIKE '%quarantine:instruction%'\`;`;
    expect(scanFiles([{ file: "l.ts", text: urlThenHit }])).toHaveLength(1);
  });

  it("fails loudly, not silently, on a file the lexer cannot parse", () => {
    // Round 4 re-review NIT: calls the real scanFiles(), not just templateSpans() in isolation,
    // so this proves scan()'s own throw path, not merely its dependency's balanced flag.
    const unbalanced = "const sql = `SELECT * FROM entries WHERE id = ?;";
    expect(() => scanFiles([{ file: "g.ts", text: unbalanced }])).toThrow(/unbalanced template literals/);
  });
});
