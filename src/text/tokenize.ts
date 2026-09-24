import { CJK_STOPWORDS, KEYWORD_MIN_TOKEN_LEN, KEYWORD_STOPWORDS, QUERY_FRAME_WORDS } from "../constants";

// ASCII chunks bypass the segmenter so ordinary queries keep their existing
// word boundaries. Only text that needs Unicode handling reaches it.
const ASCII_ONLY = /^[\x00-\x7F]*$/;
const HAN = /\p{Script=Han}/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
// A run of text that does not separate words with spaces (ideographs, kana,
// hangul, and their punctuation such as 。、). Splitting a chunk on these runs
// hands an adjacent ASCII identifier ("SB-024" in "SB-024の決定") to the ASCII
// pipeline instead of the word segmenter, which would cut it at the hyphen.
const CJK_RUN = /([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}\u3000-\u303F]+)/u;

let segmenter: Intl.Segmenter | undefined;
function wordsOf(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  const out: string[] = [];
  for (const s of segmenter.segment(text)) if (s.isWordLike) out.push(s.segment);
  return out;
}

// Lowercase each ASCII chunk, trim its edges, and drop stopwords and short
// tokens. Identifier-shaped chunks ("v1.9", "#149", URLs, paths) survive whole.
// Interior % and _ stay literal because every content LIKE site escapes them.
function asciiToken(chunk: string, frame: boolean): string | null {
  const t = chunk.toLowerCase().replace(/^[^\w#.]+|[^\w#.]+$/g, "");
  return t.length >= KEYWORD_MIN_TOKEN_LEN && HAS_LETTER_OR_DIGIT.test(t) && !KEYWORD_STOPWORDS.has(t) && !(frame && QUERY_FRAME_WORDS.has(t)) ? t : null;
}

// Split a query into lexical search tokens (#326). Canonical tokens first, in
// source order; raw-surface probes last, so every capped consumer drops a probe
// before it drops a real term.
export function tokenizeQuery(query: string): string[] {
  // Scaffolding words ("user wants to", "tell me", "what should I know") are not terms unless nothing else is.
  const terms = tokenizeTerms(query, true);
  return terms.length ? terms : tokenizeTerms(query, false);
}

function tokenizeTerms(query: string, frame: boolean): string[] {
  const tokens: string[] = [];
  const singleHan: string[] = [];
  const probes: string[] = [];
  for (const chunk of query.split(/\s+/)) {
    if (!chunk) continue;
    if (ASCII_ONLY.test(chunk)) {
      const t = asciiToken(chunk, frame);
      if (t) tokens.push(t);
      continue;
    }
    const folded = chunk.normalize("NFKC");
    if (folded !== chunk) {
      // D1 stores the original surface and SQLite's LIKE folds ASCII case only,
      // so the chunk exactly as typed is the one term that can reach content
      // saved in its compatibility form. Lowercased by every in-process matcher
      // (fusion, coverage, snippets), never here.
      if (chunk.length >= KEYWORD_MIN_TOKEN_LEN && HAS_LETTER_OR_DIGIT.test(chunk)) probes.push(chunk);
    }
    if (ASCII_ONLY.test(folded)) {
      const t = asciiToken(folded, frame);
      if (t) tokens.push(t);
      continue;
    }
    for (const run of folded.split(CJK_RUN)) {
      if (!run) continue;
      if (ASCII_ONLY.test(run)) {
        const t = asciiToken(run);
        if (t) tokens.push(t);
        continue;
      }
      for (const word of wordsOf(run)) {
        const t = word.toLowerCase();
        if (!HAS_LETTER_OR_DIGIT.test(t) || KEYWORD_STOPWORDS.has(t) || CJK_STOPWORDS.has(t)) continue;
        if (t.length >= KEYWORD_MIN_TOKEN_LEN) tokens.push(t);
        else if (HAN.test(t)) singleHan.push(t);
      }
    }
  }
  // A query that is nothing but a lone ideograph (夢) still has to reach the
  // keyword arm. Anywhere else a lone ideograph is a counter or date particle
  // (年, 月) that would only flood the candidate window.
  const ordered = tokens.length ? tokens : singleHan;
  return [...new Set([...ordered, ...probes])];
}
