// Write-time quarantine normalization (16-t3-t4-trust-spec.md 5.2).
//
// Defeats the cheap evasions (case, whitespace, homoglyphs, zero-width
// splitting, markdown wrapping, diacritics, fullwidth forms) before any
// signal pattern runs. Pure, no I/O.
//
// Cost model: a 200 KB write must score in well under 2 ms, and every full
// pass over the text costs roughly 0.3 ms, so steps that cannot change the
// result are skipped:
// - A one-byte (Latin-1) string cannot hold zero-width, bidi, tag or
//   Cyrillic/Greek characters, so the hidden counts and the Unicode fold are
//   skipped for it. V8 answers WIDE_RE on such a string without scanning.
// - A one-byte string that does hold a character above 0x7F is folded anyway
//   (score.ts's tokenizer reports it), since NFKD maps some of those
//   (ª, º, superscripts, accented letters) onto ASCII.

/** How much of the normalized text a family pattern is run against. */
export const QUARANTINE_SCAN_CHARS = 200_000;

const WIDE_RE = /[^\x00-\xff]/;
// U+200B-U+200D zero width space/non-joiner/joiner, U+2060-U+2064 word
// joiner and invisible operators, U+FEFF used as a zero-width no-break space.
const ZERO_WIDTH_TEST = /[​-‍⁠-⁤﻿]/;
const ZERO_WIDTH_RE = /[​-‍⁠-⁤﻿]/g;
// Explicit bidi embeddings, overrides and isolates. Natural RTL letters
// (Arabic, Hebrew) live in other blocks and never match.
const BIDI_RE = /[‪-‮⁦-⁩]/g;
// The Unicode tag block, used by "ASCII smuggling" to carry invisible text.
const TAG_CHAR_RE = /[\u{E0000}-\u{E007F}]/gu;
// A ZWJ-joined emoji sequence, with an optional variation selector or skin
// tone on each part. Removed from a scratch copy before counting zero-width
// characters, so a family or profession emoji's own joiners never count.
const EMOJI_ZWJ_SEQUENCE_RE =
  /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)+/gu;
// Replaced with a space, one for one, so words stay apart and `scan` keeps
// the same indices as `contextText`.
const MARKDOWN_EMPHASIS_RE = /[*_`]/g;

/**
 * The fixed Cyrillic and Greek confusable subset (5.2), both cases, plus the
 * curly apostrophes, which would otherwise let "don’t tell the user" slip
 * past a pattern written with an ASCII apostrophe.
 */
const CONFUSABLE_MAP: Readonly<Record<string, string>> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s",
  "А": "A", "Е": "E", "О": "O", "Р": "P", "С": "C", "Х": "X", "У": "Y", "І": "I", "Ј": "J", "Ѕ": "S",
  "ο": "o", "ρ": "p", "α": "a", "Ο": "O", "Ρ": "P", "Α": "A",
  "‘": "'", "’": "'", "ʼ": "'",
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
const ANY_HIDDEN_TEST = /[​-‍⁠-⁤﻿‪-‮⁦-⁩]|\uDB40[\uDC00-\uDC7F]/;
// Everything the fold removes outright, applied inside one non-ASCII run.
const FOLD_STRIP_RE = /[̀-ͯ​-‍⁠-⁤﻿‪-‮⁦-⁩]|\uDB40[\uDC00-\uDC7F]/g;
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
  const tagChars = text.match(TAG_CHAR_RE)?.length ?? 0;
  return { tagChars, zeroWidth, bidi };
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

/** The first QUARANTINE_SCAN_CHARS of the text, folded when `fold` is set. */
export function scanView(text: string, fold: boolean): string {
  // Slice before folding so a multi-megabyte note is never decomposed whole;
  // NFKD can lengthen text, so slice again after.
  const head = text.length > QUARANTINE_SCAN_CHARS ? text.slice(0, QUARANTINE_SCAN_CHARS) : text;
  const folded = fold ? foldText(head) : head;
  return folded.length > QUARANTINE_SCAN_CHARS ? folded.slice(0, QUARANTINE_SCAN_CHARS) : folded;
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
  /** Hidden-character counts from the full, untruncated input. */
  hidden: HiddenCharCounts;
}

/** The whole normalization, eagerly. scoreWrite uses the pieces above so it can skip what it does not need. */
export function normalizeForScoring(text: string): NormalizedText {
  const fold = isWide(text) || /[\x80-\xff]/.test(text);
  return { ...buildScan(scanView(text, fold)), hidden: countHidden(text) };
}
