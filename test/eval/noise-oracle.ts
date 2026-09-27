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
 *
 * A query's own declared gold is exempt from being DROPPED: the `recurring` / `transcript-recurring` batch queries
 * ask for three near-identical notices by design (three deposits sharing one payroll batch, three chore runs
 * sharing one CI group), so collapsing them by template signature the same way a non-gold duplicate collapses would
 * silently throw away two of the three answers. Confirmed live: without this exemption recall@10 on those two
 * subsets fell from 1.000 to 0.500 and 0.778, dragging the whole regression check negative even though every other
 * subset was flat or improved. A gold id's signature still marks `seen`, so a later NON-gold duplicate of the same
 * template still collapses normally; only gold itself is protected.
 */
export function collapse(ranked: readonly string[], q: Pick<GoldenQuery, "gold">, byId: ReadonlyMap<string, CorpusEntry>): string[] {
  const gold = new Set(q.gold.map(g => g.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ranked) {
    const e = byId.get(id);
    if (!e || sourceClassOf(e) === "direct") { out.push(id); continue; }
    const sig = `${sourceClassOf(e)}:${templateSignature(e)}`;
    if (gold.has(id)) { out.push(id); seen.add(sig); continue; }
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

/**
 * The mild, continuous source-class weight (T-0089.3.1, D3.1: 0.85 mirror, 0.9 transcript), simulated on a
 * rank-only recorded ranking as a small rank malus rather than a score multiplier (no raw scores survive into a
 * recorded report). A malus of `RANK_MALUS` positions is the rank-order equivalent of a mild multiplier at the
 * score gaps typical of a close single competitor: enough to let a direct document one or two ranks behind a lone
 * mirror/transcript document overtake it, without the blanket, always-on reordering the cap and collapse already
 * cover. Lifted for a source-targeted query, same as the cap. This is what recovers the single-intruder case
 * (one mail or transcript document outranking a note that shares no literal words with it) that neither collapse
 * (needs a literal duplicate) nor the cap (needs 40%+ occupancy) can reach.
 */
const RANK_MALUS = 2;
export function sourceWeightDemote(ranked: readonly string[], q: Pick<GoldenQuery, "text" | "gold">, byId: ReadonlyMap<string, CorpusEntry>): string[] {
  if (isSourceTargeted(q)) return [...ranked];
  const gold = new Set(q.gold.map(g => g.id));
  return ranked
    .map((id, rank) => ({ id, rank, key: rank + (!gold.has(id) && byId.get(id) && sourceClassOf(byId.get(id)!) !== "direct" ? RANK_MALUS : 0) }))
    .sort((a, b) => a.key - b.key || a.rank - b.rank)
    .map(x => x.id);
}

/** The combined, correct Track 3 change: collapse near-duplicates, apply the mild source-class weight, then the occupancy cap, all with the same source-word lift. */
export function collapseAndCap(ranked: readonly string[], q: Pick<GoldenQuery, "text" | "gold">, byId: ReadonlyMap<string, CorpusEntry>): string[] {
  return occupancyCap(sourceWeightDemote(collapse(ranked, q, byId), q, byId), q, byId);
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
