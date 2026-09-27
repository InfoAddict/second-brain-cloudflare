// Pure functions (recorded report, corpus spec) -> candidate report (T-0089.2.6, 14-t2-time-spec.md 6.5). Each
// re-ranks a recorded report's rankedIds to simulate a hypothetical implementation, real or a known round-4
// shortcut, without running any new code: the base data is the real, recorded baseline, only the order (and
// occasionally the membership) changes per hypothesis. They read nothing but the report and the spec (no clock,
// no randomness, no I/O), so temporal-gate-proof.test.ts can assert byte-identical results across runs.
import type { CorpusEntry, CorpusSpec } from "./corpus/types";
import { scoreQuery } from "./metrics";
import { questionTime, simulate, validAt } from "./temporal-oracle";
import type { GoldenQuery, QueryCategory, QueryResult, VariantReport } from "./types";

export type Transform = (report: VariantReport, corpus: CorpusSpec) => VariantReport;

/** Restricts a transform's effect to one category, leaving every other query's result exactly as recorded. Each
 * hypothesis below is stated about "during" (or "now") questions specifically; without this, a transform reordering
 * every query could also disturb knowledge-update or the control-not-asof floor, failing a row for a reason the
 * proof table never claims to test. */
export function onlyCategory(category: QueryCategory, transform: Transform): Transform {
  return (report, corpus) => {
    const transformed = transform(report, corpus);
    const transformedById = new Map(transformed.results.map(r => [r.queryId, r] as const));
    return { ...report, results: report.results.map(r => (r.category === category ? transformedById.get(r.queryId)! : r)) };
  };
}

const isBelief = (byId: ReadonlyMap<string, CorpusEntry>, id: string) => byId.get(id)?.retractedAt !== undefined;

/** Ids sharing the gold id's kind-and-index prefix ("tm-update-3-" from "tm-update-3-new"): a query's own timeline,
 * not the whole retrieved pool. "Newest" must be judged within this set: a filler entry elsewhere in the pool can
 * have a later createdAt than every real sibling, and demoting it would touch nothing the hypothesis is about. */
function timelineSiblings(q: GoldenQuery, byId: ReadonlyMap<string, CorpusEntry>): ReadonlySet<string> {
  const goldId = q.gold[0]?.id;
  if (!goldId) return new Set();
  const prefix = goldId.replace(/-[a-z]+$/, "-");
  return new Set([...byId.keys()].filter(id => id.startsWith(prefix)));
}

function apply(report: VariantReport, corpus: CorpusSpec, reRank: (rankedIds: readonly string[], q: GoldenQuery, byId: ReadonlyMap<string, CorpusEntry>) => string[]): VariantReport {
  const byId = new Map(corpus.entries.map(e => [e.id, e] as const));
  const queryById = new Map(corpus.queries.map(q => [q.id, q] as const));
  const results: QueryResult[] = report.results.map(r => {
    const q = queryById.get(r.queryId);
    if (!q) return r;
    const rankedIds = reRank(r.rankedIds, q, byId);
    return { ...r, rankedIds, metrics: scoreQuery(rankedIds, q.gold, q.forbidden) };
  });
  return { ...report, results };
}

/** Row 1: the plan oracle as D-RET specifies it: keep documents valid at T, with any retracted belief demoted below
 * them (temporal-oracle's "supersession" already implements exactly this). The transforms exist to name it as one
 * hypothesis among the round-4 shortcuts, not to duplicate its logic. */
export const planOracle: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) => simulate("supersession", ranked, q, byId));

/** Row 2: the oracle without beliefs at all -- an ordinary "drop everything invalid" implementation that never
 * shows a retracted belief, even demoted. */
export const oracleWithoutBeliefs: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) => {
  const t = questionTime(q);
  return ranked.filter(id => { const e = byId.get(id); return !e || validAt(e, t); });
});

/** Row 3: valid documents in order, with each retracted belief re-inserted directly under the first gold id,
 * rather than pushed to the very end -- a plausible "attach the correction to its subject" implementation. */
export const oracleBeliefsUnderTarget: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) => {
  const t = questionTime(q);
  const validOrUnknown = (id: string) => { const e = byId.get(id); return !e || validAt(e, t); };
  const valid = ranked.filter(validOrUnknown);
  const beliefs = ranked.filter(id => !validOrUnknown(id) && isBelief(byId, id));
  const goldId = q.gold[0]?.id;
  const out: string[] = [];
  let attached = false;
  for (const id of valid) {
    out.push(id);
    if (id === goldId) { out.push(...beliefs); attached = true; }
  }
  if (!attached) out.push(...beliefs);
  return out;
});

/** Row 5: demotes the newest-created document within the query's own timeline (not the whole pool: a filler
 * elsewhere could be newer and irrelevant to the hypothesis), the exact shortcut round 4 found winning on the old
 * corpus design at +0.382 MRR by coincidence, before this round's gold made "newest" ambiguous. */
export const demoteNewest: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) => {
  const siblings = timelineSiblings(q, byId);
  const inTimeline = ranked.filter(id => siblings.has(id));
  if (!inTimeline.length) return [...ranked];
  const newest = [...inTimeline].sort((a, b) => (byId.get(b)?.createdAt ?? 0) - (byId.get(a)?.createdAt ?? 0))[0];
  return [...ranked.filter(id => id !== newest), newest];
});

/** Row 6: demotes any document whose text contains "Correction" or "Looking back" -- a lexical shortcut that
 * happens to demote several of this round's own gold documents (corrected-backdated, recap-gold). */
export const demoteCorrectionLookingBack: Transform = (report, corpus) => apply(report, corpus, (ranked, _q, byId) => {
  const flagged = (id: string) => /Correction|Looking back/.test(byId.get(id)?.content ?? "");
  return [...ranked.filter(id => !flagged(id)), ...ranked.filter(flagged)];
});

/** Row 7: boosts any document containing " was " to the front -- tense wording alone, the exact shortcut that let
 * a deleted date parser pass phrase-dated at +0.243 MRR in T-0089.2.5's corpus, tested here against gold docs that
 * also use "was" (during-before-change) so it cannot win by coincidence either. */
export const boostWas: Transform = (report, corpus) => apply(report, corpus, (ranked, _q, byId) => {
  const flagged = (id: string) => / was /.test(byId.get(id)?.content ?? "");
  return [...ranked.filter(flagged), ...ranked.filter(id => !flagged(id))];
});

/** Row 8: boosts any document carrying an explicit calendar date (a month name or an ISO date) to the front. */
export const boostExplicitDate: Transform = (report, corpus) => apply(report, corpus, (ranked, _q, byId) => {
  const flagged = (id: string) => /\d{4}-\d{2}-\d{2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(byId.get(id)?.content ?? "");
  return [...ranked.filter(flagged), ...ranked.filter(id => !flagged(id))];
});

/** Row 9: the plan oracle's ordering, except the retracted belief (if any) is promoted to rank 1 instead of being
 * demoted -- a belief-time system that surfaces the cancelled move as the top answer. */
export const oracleBeliefFirst: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) => {
  const ordered = simulate("supersession", ranked, q, byId);
  const belief = ordered.find(id => isBelief(byId, id));
  if (!belief) return ordered;
  return [belief, ...ordered.filter(id => id !== belief)];
});

/** Row 10: as-of on created_at only, with no upper bound at all -- excludes every document created after T
 * (dropping late-told facts, P2) but never re-includes anything superseded before T either. */
export const asOfCreatedAtOnly: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) => {
  const t = questionTime(q);
  return ranked.filter(id => (byId.get(id)?.createdAt ?? 0) <= t);
});

/** Row 11: as-of on created_at, respecting a document's own validUntil, but ignoring a backdated validFrom (so a
 * document told late about an earlier truth is still excluded, the exact case retro-norecap/recap-only test). */
export const asOfCreatedAtRespectsValidUntil: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) => {
  const t = questionTime(q);
  return ranked.filter(id => {
    const e = byId.get(id);
    if (!e) return true;
    const until = Math.min(e.validUntil ?? Infinity, e.retractedAt ?? Infinity);
    return e.createdAt <= t && t < until;
  });
});

/** Row 12: belief-time as-of -- promotes whatever was believed at T (the newest document created at or before T,
 * regardless of what was later declared actually true) and hides the actually-true answer if a belief superseded
 * it by T. The exact reading D-RET replaced (02's draft), which corrected-backdated and retracted-past must both
 * fail: the actually-true correction/old answer must not be hidden behind a belief. */
export const beliefTimeAsOf: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) => {
  const t = questionTime(q);
  const toldByT = ranked.filter(id => (byId.get(id)?.createdAt ?? 0) <= t);
  return [...toldByT].sort((a, b) => (byId.get(b)?.createdAt ?? 0) - (byId.get(a)?.createdAt ?? 0));
});

/** Row 13: keeps only the single newest-created document among a query's own ranked ids, dropping everything
 * else -- the crudest possible "latest wins" implementation. */
export const keepOnlyNewest: Transform = (report, corpus) => apply(report, corpus, (ranked, _q, byId) => {
  if (!ranked.length) return [];
  return [[...ranked].sort((a, b) => (byId.get(b)?.createdAt ?? 0) - (byId.get(a)?.createdAt ?? 0))[0]];
});

/** Row 14: drops every document belonging to the query's own timeline -- simulates a supersede that also deleted
 * the whole history it was meant to keep. */
export const dropOwnTimeline: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) => {
  const timelineIds = new Set(q.gold.map(g => g.id.replace(/-[a-z]+$/, "-")).flatMap(prefix => [...byId.keys()].filter(id => id.startsWith(prefix))));
  return ranked.filter(id => !timelineIds.has(id));
});

/** Row 15: applies the current-validity predicate (valid at EVAL_NOW) to every question, including as-of ones --
 * the mistake of answering "where is it now" no matter what date was actually asked about. */
export const currentValidityEverywhere: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) =>
  simulate("supersession", ranked, { ...q, asOf: undefined, expectedAsOf: undefined }, byId));

/** Row 16 / KU-3: reorders newest-created first, the shortcut a plain recency boost takes (temporal-oracle's own
 * "recency" mode). */
export const recencySort: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) => simulate("recency", ranked, q, byId));

/** KU-1: the current oracle -- the same plan oracle (row 1), restricted in practice to knowledge-update questions
 * by the corpus's own category split; kept as a distinct export so the proof table can name it for that category. */
export const currentOracle: Transform = planOracle;

/** KU-2: the current oracle without D-RET's restore -- a retraction closes its target permanently, so "old" stays
 * hidden even after "bad" is itself retracted (the belief-time reading D-RET replaced, applied to a current
 * question instead of a past one). */
export const currentOracleNoRestore: Transform = (report, corpus) => apply(report, corpus, (ranked, q, byId) => {
  const t = questionTime(q);
  const siblings = timelineSiblings(q, byId);
  // This corpus declares "actually-true" validity directly (D-RET already applied: a restored row has no
  // validUntil at all), so "no restore" cannot be read off a validUntil field -- it must be simulated: any row
  // that predates a belief in its own timeline stays permanently closed by it, restored or not.
  const beliefs = [...siblings].map(id => byId.get(id)).filter((e): e is CorpusEntry => !!e && e.retractedAt !== undefined);
  return ranked.filter(id => {
    const e = byId.get(id);
    if (!e) return true;
    if (isBelief(byId, id)) return false;
    const closedByBelief = beliefs.some(b => (e.validFrom ?? e.createdAt) < b.createdAt && b.createdAt <= t);
    return !closedByBelief && validAt(e, t);
  });
});
