// Write-time quarantine normalization (16-t3-t4-trust-spec.md 5.2).
//
// Defeats the cheap evasions (case, whitespace, homoglyphs, zero-width
// splitting, markdown wrapping, diacritics, fullwidth forms) before any
// signal pattern runs. Pure, no I/O.
//
// Cost model: the first call in a fresh isolate (no JIT yet) must fit the
// free plan's 10 ms CPU per invocation with the rest of the write, so:
// - Only a byte budget is scored (director, 2026-09-27): the first 24 KB and
//   the last 8 KB of UTF-16 code units. Anything longer is scored `partial`;
//   text in the unscored middle escapes inline scoring, and Lane W queues it
//   for a bounded background pass.
// - A one-byte (Latin-1) string cannot hold zero-width, bidi, tag or
//   Cyrillic/Greek characters, so the hidden counts and the Unicode fold are
//   skipped for it. V8 answers WIDE_RE on such a string without scanning.
// - A one-byte string that does hold a character above 0x7F is folded anyway
//   (score.ts's tokenizer reports it), since NFKD maps some of those
//   (ª, º, superscripts, accented letters) onto ASCII.

export const QUARANTINE_SCORE_HEAD_CHARS = 24 * 1024;
export const QUARANTINE_SCORE_TAIL_CHARS = 8 * 1024;
export const QUARANTINE_SCORE_CHARS = QUARANTINE_SCORE_HEAD_CHARS + QUARANTINE_SCORE_TAIL_CHARS;
// Joins head and tail. Not whitespace and not a word character, so no \s+ or
// \b pattern matches across it, and the tokenizer splits on it.
const SEAM = "\u0000";
// The seam plus a surrogate pair kept whole at each cut.
const BUDGET_SLACK = 3;

const isHighSurrogate = (c: number) => c >= 0xD800 && c <= 0xDBFF;
const isLowSurrogate = (c: number) => c >= 0xDC00 && c <= 0xDFFF;

/** The text the scorer reads: all of it within the budget, else head + seam + tail and `partial`. */
export function budgetSlice(text: string): { text: string; partial: boolean } {
  if (text.length <= QUARANTINE_SCORE_CHARS) return { text, partial: false };
  let headEnd = QUARANTINE_SCORE_HEAD_CHARS;
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd++;
  let tailStart = text.length - QUARANTINE_SCORE_TAIL_CHARS;
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart--;
  return { text: text.slice(0, headEnd) + SEAM + text.slice(tailStart), partial: true };
}

const WIDE_RE = /[^\x00-\xff]/;
// U+200B-U+200D zero width space/non-joiner/joiner, U+2060-U+2064 word
// joiner and invisible operators, U+FEFF used as a zero-width no-break space.
const ZERO_WIDTH_TEST = /[\u200B-\u200D\u2060-\u2064\uFEFF]/;
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060-\u2064\uFEFF]/g;
// Explicit bidi embeddings, overrides and isolates. Natural RTL letters
// (Arabic, Hebrew) live in other blocks and never match.
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g;
// The Unicode tag block, used by "ASCII smuggling" to carry invisible text.
const TAG_CHAR_RE = /[\u{E0000}-\u{E007F}]/gu;
// A ZWJ-joined emoji sequence, with an optional variation selector or skin
// tone on each part. Removed from a scratch copy before counting zero-width
// characters, so a family or profession emoji's own joiners never count.
const EMOJI_ZWJ_SEQUENCE_RE =
  /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)+/gu;
// Replaced with a space, one for one, so words stay apart and `scan` keeps
// the same indices as `contextText`.
const MARKDOWN_EMPHASIS_RE = /[*_`]/g;

/**
 * The fixed Cyrillic and Greek confusable subset (5.2), both cases, plus the
 * curly apostrophes, which would otherwise let "don’t tell the user" slip
 * past a pattern written with an ASCII apostrophe.
 */
const CONFUSABLE_MAP: Readonly<Record<string, string>> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x", "\u0443": "y", "\u0456": "i", "\u0458": "j", "\u0455": "s",
  "\u0410": "A", "\u0415": "E", "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0425": "X", "\u0423": "Y", "\u0406": "I", "\u0408": "J", "\u0405": "S",
  "\u03BF": "o", "\u03C1": "p", "\u03B1": "a", "\u039F": "O", "\u03A1": "P", "\u0391": "A",
  "\u2018": "'", "\u2019": "'", "\u02BC": "'",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE_MAP).join("")}]`, "g");

export interface HiddenCharCounts {
  /** Unicode tag characters (H1), any occurrence. */
  tagChars: number;
  /** Zero-width characters (H2), counted outside ZWJ emoji sequences. */
  zeroWidth: number;
  /** Explicit bidi control characters (H3), never natural RTL letters. */
  bidi: number;
}

const NO_HIDDEN: HiddenCharCounts = Object.freeze({ tagChars: 0, zeroWidth: 0, bidi: 0 });
// Any hidden character at all: one pass decides whether the three counts run.
const ANY_HIDDEN_TEST = /[\u200B-\u200D\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]|\uDB40[\uDC00-\uDC7F]/;
// Everything the fold removes outright, applied inside one non-ASCII run.
const FOLD_STRIP_RE = /[\u0300-\u036F\u200B-\u200D\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]|\uDB40[\uDC00-\uDC7F]/g;
const NON_ASCII_RUN_RE = /[^\x00-\x7f]+/g;

/** True when the string holds a character above U+00FF (free to answer for a one-byte string). */
export function isWide(text: string): boolean {
  return WIDE_RE.test(text);
}

/** Hidden-character counts over the full, untruncated text. */
export function countHidden(text: string): HiddenCharCounts {
  if (!isWide(text) || !ANY_HIDDEN_TEST.test(text)) return NO_HIDDEN;
  const zeroWidth = ZERO_WIDTH_TEST.test(text)
    ? text.replace(EMOJI_ZWJ_SEQUENCE_RE, "").match(ZERO_WIDTH_RE)?.length ?? 0
    : 0;
  const bidi = text.match(BIDI_RE)?.length ?? 0;
  const tagChars = text.replace(RGI_SUBDIVISION_FLAG_RE, "").match(TAG_CHAR_RE)?.length ?? 0;
  return { tagChars, zeroWidth, bidi };
}

// The only emoji tag sequences that render as flags (RGI): England, Scotland
// and Wales. Any other tag run, even flag-shaped (black flag, tags, cancel
// tag), can spell arbitrary text, so it stays an H1 signal.
const RGI_SUBDIVISION_FLAG_RE =
  /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu;

// ---------------------------------------------------------------------------
// Decoding (director, 2026-09-27, after the Codex review): an instruction
// written through an encoding reads as one to any model that decodes it, so
// every pattern runs on the decoded text. Covered: HTML entities (decimal,
// hex, the named ones that stand for spaces and punctuation, and the
// letter-form ones like &iscr; and &iacute;), percent-encoding including
// UTF-8, JS \u, \u{} and \x escapes, and quoted-printable bytes and soft
// line breaks. Layers are unwrapped up to DECODE_MAX_PASSES; a fourth layer is
// left as is. Every decoding shortens the text, so the byte budget holds.

const DECODE_MAX_PASSES = 3;
const DECODE_TRIGGER_RE = /[&%\\=]/;
const NUMERIC_ENTITY_RE = /&#(?:[xX]([0-9a-fA-F]{1,8})|(\d{1,10}));?/g;
const NAMED_ENTITY_RE = /&([A-Za-z][A-Za-z0-9]{1,31});/g;
const LETTER_ENTITY_RE =
  /^([A-Za-z])(?:scr|fr|opf|acute|grave|circ|uml|tilde|ring|cedil|caron|breve|macr|ogon|dot|dblac|strok)$/;
const PERCENT_RUN_RE = /(?:%[0-9a-fA-F]{2})+/g;
const QP_SOFT_BREAK_RE = /=\r?\n/g;
const QP_RUN_RE = /(?:=[0-9a-fA-F]{2})+/g;
const JS_ESCAPE_RE = /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/g;

// A Map, so a name like "constructor" can never resolve to an Object prototype member.
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map(Object.entries({
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00A0", Tab: "\t", NewLine: "\n",
  colon: ":", sol: "/", bsol: "\\", period: ".", comma: ",", semi: ";", excl: "!", quest: "?",
  lowbar: "_", ast: "*", grave: "`", hyphen: "-", dash: "-", minus: "-", equals: "=", plus: "+",
  num: "#", dollar: "$", percnt: "%", commat: "@", verbar: "|", vert: "|", Hat: "^", tilde: "~",
  lpar: "(", rpar: ")", lsqb: "[", rsqb: "]", lbrack: "[", rbrack: "]", lcub: "{", rcub: "}", lbrace: "{", rbrace: "}",
  ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", hairsp: "\u200A", numsp: "\u2007", puncsp: "\u2008",
  ZeroWidthSpace: "\u200B", zwnj: "\u200C", zwj: "\u200D", NoBreak: "\u2060", lrm: "\u200E", rlm: "\u200F",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D", ndash: "\u2013", mdash: "\u2014",
}));

function codePointOrNull(cp: number): string | null {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return null;
  return String.fromCodePoint(cp);
}

/** A run of %XX (or =XX) bytes: UTF-8 when it is valid UTF-8, else only the ASCII bytes. */
function decodeByteRun(run: string, marker: string): string {
  const hex = run.split(marker).slice(1);
  try {
    return decodeURIComponent(hex.map(h => `%${h}`).join(""));
  } catch {
    return hex.map(h => {
      const b = parseInt(h, 16);
      return b < 0x80 ? String.fromCharCode(b) : `${marker}${h}`;
    }).join("");
  }
}

function decodeOnce(s: string): string {
  if (s.includes("=")) s = s.replace(QP_SOFT_BREAK_RE, "");
  if (s.includes("&")) {
    s = s
      .replace(NUMERIC_ENTITY_RE, (m, hex: string | undefined, dec: string | undefined) =>
        codePointOrNull(hex !== undefined ? parseInt(hex, 16) : Number(dec)) ?? m)
      .replace(NAMED_ENTITY_RE, (m, name: string) =>
        NAMED_ENTITIES.get(name) ?? NAMED_ENTITIES.get(name.toLowerCase()) ?? LETTER_ENTITY_RE.exec(name)?.[1] ?? m);
  }
  if (s.includes("%")) s = s.replace(PERCENT_RUN_RE, run => decodeByteRun(run, "%"));
  if (s.includes("\\")) {
    s = s.replace(JS_ESCAPE_RE, (m, braced: string | undefined, u4: string | undefined, x2: string | undefined) =>
      codePointOrNull(parseInt(braced ?? u4 ?? x2 ?? "", 16)) ?? m);
  }
  if (s.includes("=")) s = s.replace(QP_RUN_RE, run => decodeByteRun(run, "="));
  return s;
}

/** Unwraps up to DECODE_MAX_PASSES layers of encoding. Free when the text holds none of & % \ =. */
export function decodeEncodings(text: string): string {
  let s = text;
  for (let pass = 0; pass < DECODE_MAX_PASSES && DECODE_TRIGGER_RE.test(s); pass++) {
    const next = decodeOnce(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

// Prose repeats the same short runs (’, “, é) thousands of times.
const SHORT_RUN_CACHE = new Map<string, string>();
const SHORT_RUN_MAX = 2;
const SHORT_RUN_CACHE_MAX = 512;

function foldRun(run: string): string {
  if (run.length <= SHORT_RUN_MAX) {
    const hit = SHORT_RUN_CACHE.get(run);
    if (hit !== undefined) return hit;
  }
  const folded = run
    .normalize("NFKD")
    .replace(FOLD_STRIP_RE, "")
    .replace(CONFUSABLE_RE, c => CONFUSABLE_MAP[c]);
  if (run.length <= SHORT_RUN_MAX && SHORT_RUN_CACHE.size < SHORT_RUN_CACHE_MAX) SHORT_RUN_CACHE.set(run, folded);
  return folded;
}

/**
 * Compatibility-decomposes (NFKD, the "K" of the spec's NFKC), drops
 * combining diacritics so "ignóre" reads as "ignore", maps confusables and
 * strips zero-width, bidi and tag characters. Case is left alone; the caller
 * lowercases only when a pattern actually has to run.
 *
 * Works run by run on the non-ASCII stretches, so mostly-ASCII text costs one
 * pass. ASCII is already NFKD-stable, and a combining mark after an ASCII
 * letter is its own run and is simply dropped, which is what decomposing the
 * pair would have produced.
 */
export function foldText(text: string): string {
  return text.replace(NON_ASCII_RUN_RE, foldRun);
}

/**
 * The already-budgeted text, folded when `fold` is set. NFKD can lengthen
 * text (U+FDFA becomes 18 characters), so an expanded result is budgeted
 * again, keeping its own head and tail, and reported `truncated`.
 */
export function scanView(budgeted: string, fold: boolean): { view: string; truncated: boolean } {
  const folded = fold ? foldText(budgeted) : budgeted;
  if (folded.length <= QUARANTINE_SCORE_CHARS + BUDGET_SLACK) return { view: folded, truncated: false };
  return { view: budgetSlice(folded).text, truncated: true };
}

export interface ScanText {
  /** Markdown-defeated, lowercased text: family patterns run against this. */
  scan: string;
  /**
   * Same length and indices as `scan`, with markdown emphasis left in place.
   * Used only to look around a match (quotes, code fences) for damping.
   */
  contextText: string;
}

export function buildScan(view: string): ScanText {
  const contextText = view.toLowerCase();
  return { scan: contextText.replace(MARKDOWN_EMPHASIS_RE, " "), contextText };
}

export interface NormalizedText extends ScanText {
  /** Hidden-character counts over the budgeted text. */
  hidden: HiddenCharCounts;
  /** Part of the input was not scored (over the budget, or expanded past it by folding). */
  partial: boolean;
}

/** The whole normalization, eagerly. scoreWrite uses the pieces above so it can skip what it does not need. */
export function normalizeForScoring(text: string): NormalizedText {
  const budget = budgetSlice(text);
  const decoded = decodeEncodings(budget.text);
  const fold = isWide(decoded) || /[\x80-\xff]/.test(decoded);
  const { view, truncated } = scanView(decoded, fold);
  return { ...buildScan(view), hidden: countHidden(decoded), partial: budget.partial || truncated };
}
