import type { CorpusEntry } from "./corpus/types";
import type { GoldenQuery } from "./types";

/**
 * Track 3's source classes, as this corpus uses them (`docs/superpowers/specs/2026-09-26-v4/03-provenance-and-trust.md`
 * and the T-0089.3.5 director addition for transcripts). Mirrors `src/memory/source-class.ts`'s eventual rule
 * without importing from `src/`: this corpus and its oracle stay entirely inside `test/eval/`, and `codex-session`
 * / `cursor-session` are not yet in `src/constants.ts`'s `TRANSCRIPT_SOURCES` (only `claude-code` is, as of this
 * round) so there is nothing there to import from yet.
 */
const MIRROR_SOURCES: ReadonlySet<string> = new Set(["email-gmail"]);
const TRANSCRIPT_SOURCES: ReadonlySet<string> = new Set(["codex-session", "cursor-session"]);

export type SourceClass = "mirror" | "transcript" | "direct";

export function sourceClassOf(e: Pick<CorpusEntry, "source">): SourceClass {
  if (MIRROR_SOURCES.has(e.source)) return "mirror";
  if (TRANSCRIPT_SOURCES.has(e.source)) return "transcript";
  return "direct";
}

/**
 * The recurring-notice template signature: the line right after a mail's `From:` line (its `Subject:`) or a
 * transcript's shared wrapper-open line (its first turn), digits collapsed to a single marker so an amount,
 * confirmation code or run number never breaks a match. Two mirror or transcript documents with the same
 * signature are the near-duplicates the plan's collapse step is for; a direct note never participates (`src`'s
 * planned collapse is mirror-only too).
 */
export function templateSignature(e: Pick<CorpusEntry, "source" | "content">): string {
  const line = e.content.split("\n")[1] ?? e.content.split("\n")[0] ?? "";
  return `${e.source}:${line.toLowerCase().replace(/[0-9]+/g, "#")}`;
}

/** An explicit source word in the query text: the plan's cap lift ("email", "calendar", "meeting", "inbox"), extended to this corpus's transcript sources. */
const SOURCE_WORD_RE = /\b(email|inbox|e-mail|calendar|meeting|cursor|codex|coding session|session)\b/i;
export const isSourceTargeted = (q: Pick<GoldenQuery, "text">): boolean => SOURCE_WORD_RE.test(q.text);

const EVAL_TOP_K = 10;
/** Matches T-0089.3.1's default (D3.1, approved 2026-09-26). */
const MIRROR_MAX_SHARE = 0.4;

/**
 * Near-duplicate collapse (D3.3): among mirror and transcript rows only, keep the best-ranked (first-seen) document
 * per template signature and drop the rest, preserving the order of everything else. A direct row is never
 * collapsed. Pure reordering/filtering of the RECORDED ranking; it adds no id recall did not already return.
 */
export function collapse(ranked: readonly string[], byId: ReadonlyMap<string, CorpusEntry>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ranked) {
    const e = byId.get(id);
    if (!e || sourceClassOf(e) === "direct") { out.push(id); continue; }
    const sig = `${sourceClassOf(e)}:${templateSignature(e)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(id);
  }
  return out;
}

/**
 * The occupancy cap (T-0089.3.1): once more than `MIRROR_MAX_SHARE` of the top K is mirror or transcript, the
 * excess drops below the next non-capped results, order within each class preserved. Lifted entirely for a
 * source-targeted query, per the plan's "cap is lifted... keeps the Aug 16 lesson" rule.
 */
export function occupancyCap(ranked: readonly string[], q: Pick<GoldenQuery, "text">, byId: ReadonlyMap<string, CorpusEntry>): string[] {
  if (isSourceTargeted(q)) return [...ranked];
  const cap = Math.floor(MIRROR_MAX_SHARE * EVAL_TOP_K);
  const kept: string[] = [], overflow: string[] = [];
  let cappedSeen = 0;
  for (const id of ranked) {
    const e = byId.get(id);
    const capped = !!e && sourceClassOf(e) !== "direct";
    if (!capped || cappedSeen < cap) { kept.push(id); if (capped) cappedSeen++; }
    else overflow.push(id);
  }
  return [...kept, ...overflow];
}

/** The combined, correct Track 3 change: collapse near-duplicates, then apply the occupancy cap with its source-word lift. */
export function collapseAndCap(ranked: readonly string[], q: Pick<GoldenQuery, "text">, byId: ReadonlyMap<string, CorpusEntry>): string[] {
  return occupancyCap(collapse(ranked, byId), q, byId);
}

/** Wrong candidate 1: demotes every mirror/transcript row below every direct row, on every query, with no source-word lift. Breaks the "wants the mail/transcript" controls. */
export function blanketDemote(ranked: readonly string[], byId: ReadonlyMap<string, CorpusEntry>): string[] {
  const direct: string[] = [], rest: string[] = [];
  for (const id of ranked) {
    const e = byId.get(id);
    (e && sourceClassOf(e) !== "direct" ? rest : direct).push(id);
  }
  return [...direct, ...rest];
}

/** Wrong candidate 2: drops every mirror/transcript row outright, on every query. */
export function dropNonDirect(ranked: readonly string[], byId: ReadonlyMap<string, CorpusEntry>): string[] {
  return ranked.filter(id => { const e = byId.get(id); return !e || sourceClassOf(e) === "direct"; });
}

/** Wrong candidate 3: pure recency, ignoring source class and relevance entirely. */
export function pureRecency(ranked: readonly string[], byId: ReadonlyMap<string, CorpusEntry>): string[] {
  return [...ranked].sort((a, b) => (byId.get(b)?.createdAt ?? 0) - (byId.get(a)?.createdAt ?? 0));
}
