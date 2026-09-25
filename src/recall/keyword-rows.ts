/**
 * Ids first, text last. The keyword arm used to read every candidate note in full (up to KEYWORD_CANDIDATE_LIMIT of them, tens of
 * KB each) so the Worker could weigh each query term in it, and the Worker paid CPU to parse and scan those bytes. D1 does that
 * work now: each candidate row comes back with, per term, one number, and no text.
 *
 *   0  the term is not in the note
 *   1  it is, but only inside longer words ("cat" in "concatenate")
 *   2  it is, standing as a word of its own
 *
 * "Standing as a word" is the fusion's boundary rule, `(?<![\w])term(?![\w])`: the characters either side are not [A-Za-z0-9_].
 * The rule is decided on the first two occurrences of the term: a note whose first two are inside longer words and whose third is
 * a word of its own reads as 1 here and 2 in the old scan. SQLite's lower() folds ASCII only (as LIKE does), so a term with other
 * characters is also looked for in the note's own text in the forms text takes: as typed, lowercase, UPPERCASE and Capitalised
 * ("café" finds "CAFÉ", "москва" finds "МОСКВА", a full-width probe finds itself). A note that mixes cases inside one word
 * ("cAFÉ") reads as absent for such a term, where the old scan lowercased the whole note.
 */
import type { KeywordRow } from "./types";

export type MatchLevel = 0 | 1 | 2;

const WORD_CHAR = `'[A-Za-z0-9_]'`;

/** `raw` is the note's own text; a query with a non-ASCII term asks the inner SELECT to carry it (see above). */
const isWide = (t: string) => /[^\x00-\x7f]/.test(t);
const capitalised = (t: string) => { const [head, ...rest] = Array.from(t.toLowerCase()); return head ? head.toUpperCase() + rest.join("") : t; };
/** The forms of a non-ASCII term to look for in the note's own text, apart from the lowercase one searched in `lc`. */
const rawForms = (t: string): string[] => [...new Set([t, t.toUpperCase(), capitalised(t)])].filter(v => v !== t.toLowerCase());
const chars = (t: string) => Array.from(t).length;
export const rawColumn = (terms: readonly string[], expr: string) => (terms.some(isWide) ? `, ${expr} AS raw` : "");

/** `pos` is a SQL expression holding a 1-based match position (never 0 when this is evaluated). */
const standsAlone = (pos: string, len: string) =>
  `(substr(lc, ${pos} - 1, 1) NOT GLOB ${WORD_CHAR} AND substr(lc, ${pos} + ${len}, 1) NOT GLOB ${WORD_CHAR})`;

/**
 * Wraps `inner` (a SELECT that yields `passthrough` columns plus `lc`, the lowercased note text) in the SQL that turns `lc` into
 * one `l<i>` level column per term. `sql` is a WITH ... SELECT whose rows carry the passthrough columns and `l0..l<n-1>`;
 * `returned` are the passthrough columns the caller gets back (the rest, such as ranking keys, only order the rows).
 * `binds` are the terms to bind after `inner`'s own binds: each once, referenced by number.
 */
export function withMatchLevels(inner: string, passthrough: string[], terms: readonly string[], orderBy: string, returned: string[] = passthrough): { sql: string; binds: string[] } {
  const lowered = terms.map(t => t.toLowerCase());
  const cols = passthrough.join(", ");
  // Each term is bound once and referenced by number wherever it is used, so a query with 16 terms binds 16 (plus 1 per non-ASCII
  // term), not 3 or 4 apiece: D1 allows 100 bound values in a statement. Numbers continue after `inner`'s plain placeholders.
  const base = (inner.match(/\?/g) ?? []).length;
  const wide = terms.map((t, i) => [t, i] as const).filter(([t]) => isWide(t));
  const at = (i: number) => `?${base + 1 + i}`;
  // the raw forms of each wide term, bound after all the lowercased terms, one placeholder per distinct form
  const forms = new Map<number, { form: string; at: string }[]>();
  let next = base + 1 + terms.length;
  for (const [t, i] of wide) forms.set(i, rawForms(t).map(form => ({ form, at: `?${next++}` })));
  const first = terms.map((t, i) => {
    if (!isWide(t)) return `instr(lc, ${at(i)}) AS p${i}`;
    const raw = forms.get(i)!;
    return `CASE WHEN instr(lc, ${at(i)}) > 0 THEN instr(lc, ${at(i)})${raw.map(f => ` WHEN instr(raw, ${f.at}) > 0 THEN instr(raw, ${f.at})`).join("")} ELSE 0 END AS p${i}, `
      + `CASE WHEN instr(lc, ${at(i)}) > 0 THEN ${chars(lowered[i])}${raw.map(f => ` WHEN instr(raw, ${f.at}) > 0 THEN ${chars(f.form)}`).join("")} ELSE 0 END AS w${i}`;
  }).join(", ");
  const rawCol = wide.length ? ", raw" : "";
  const wcols = wide.map(([, i]) => `w${i}`);
  const carried = [...terms.map((_, i) => `p${i}`), ...wcols].join(", ");
  const second = terms.map((_, i) => `instr(substr(lc, p${i} + 1), ${at(i)}) AS q${i}`).join(", ");
  const level = terms.map((t, i) => {
    const len = isWide(t) ? `w${i}` : String(chars(lowered[i]));
    return `CASE WHEN p${i} = 0 THEN 0 WHEN ${standsAlone(`p${i}`, len)} THEN 2 WHEN q${i} = 0 THEN 1 WHEN ${standsAlone(`(p${i} + q${i})`, len)} THEN 2 ELSE 1 END AS l${i}`;
  }).join(", ");
  const sql = `WITH s AS MATERIALIZED (${inner})
    SELECT ${returned.join(", ")}, ${terms.map((_, i) => `l${i}`).join(", ")} FROM (
      SELECT ${cols}, ${level} FROM (
        SELECT ${cols}, lc, ${carried}, ${second} FROM (
          SELECT ${cols}, lc${rawCol}, ${first} FROM s
        )
      )
    ) ORDER BY ${orderBy}`;
  return { sql, binds: [...lowered, ...wide.flatMap(([, i]) => forms.get(i)!.map(f => f.form))] };
}

/** A keyword row as the SQL above returns it: no text, and each term's level. */
export function rowWithLevels(raw: Record<string, unknown>, terms: readonly string[]): KeywordRow {
  // A row that already carries its text (a double standing in for D1) is scored from that text, as the tag path's rows are.
  if (typeof raw.content === "string" && !("l0" in raw)) return raw as unknown as KeywordRow;
  const hits = new Map<string, MatchLevel>();
  terms.forEach((t, i) => hits.set(t, Number(raw[`l${i}`] ?? 0) as MatchLevel));
  return { id: raw.id as string, tags: raw.tags as string, source: raw.source as string, created_at: raw.created_at as number, hits };
}
