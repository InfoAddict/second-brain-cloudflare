import type { GoldenQuery } from "../types";
import { edge, entry, finish, isoDay, pick, pseudoWords, query, rng, utc } from "./synthetic-common";
import { DAY_MS, EVAL_NOW } from "./types";
import type { CorpusEdge, CorpusEntry, CorpusSpec } from "./types";

const THINGS = ["studio lease", "supplier", "support hotline", "backup provider", "delivery depot", "meeting room", "billing address", "training venue", "design agency", "weekly pickup", "storage unit", "parking permit"];
const STREETS = ["Maple", "Amber", "Harbor", "Cedar", "Willow", "Granite", "Linden", "Copper", "Juniper", "Aspen", "Birch", "Slate", "Falcon", "Meadow", "Summit", "Orchard", "Ridge", "Lantern", "Marble", "Prairie"];
const KINDS = ["Street", "Court", "Wharf", "Lane"];
const PLACES = STREETS.flatMap(s => KINDS.map(k => `${s} ${k}`));
const MONTH_DAY_NAMES = [["Aug", 8], ["Jun", 3], ["Apr", 12], ["Jul", 21], ["Mar", 9], ["May", 17], ["Oct", 5], ["Nov", 14], ["Dec", 2], ["Feb", 26]] as const;

/**
 * Timeline shapes (T-0089.2.6 adds the last four to fix round-4's shortcut-friendly gold, 14-t2-time-spec.md 6.2;
 * silent-fresh and silent-true add two more in the adversary round 2 fix, see the "silent" cases below).
 * update: plain change, gold split into a before/after pair. retro: backdated and retrospective notes, gold in the
 * middle. retracted: a fact later withdrawn, then the withdrawal itself retracted (D-RET restores it). edited: one
 * document edited after the as-of date. retro-norecap: backdated with no recap note, so gold is the newest document
 * and created after the as-of date. corrected: wrong from the start, corrected later; gold is newest, forbidden is
 * the original. recap-only: the recap is the only valid document at the as-of date, and also the newest by creation.
 * silent: a contradiction the loader never linked with an edge, so nothing but staleness can favor the new fact.
 * silent-fresh: the same shape, but "old" is under the 90-day staleness threshold, so gold stays "old". silent-true:
 * a lone state fact past the threshold with no rival at all, so demoting on age and tag alone still has room to
 * lose.
 */
export const TEMPORAL_TYPES = {
  update: 35, retro: 35, retracted: 30, edited: 20, "retro-norecap": 30, corrected: 30, "recap-only": 30, silent: 30,
  "silent-fresh": 20, "silent-true": 20,
} as const;
type Kind = keyof typeof TEMPORAL_TYPES;

/** The dates the past questions are asked about. */
export const AS_OF_APRIL = utc(4, 15);
export const AS_OF_JULY = utc(7, 10);
export const AS_OF_LATE_JULY = utc(7, 20);
/** during-after-change (T-0089.2.6): after the update kind's own supersede, so gold is the newest document. */
export const AS_OF_AUGUST = utc(8, 20);
/** corrected-backdated (T-0089.2.6): before the correction was written, so as-of must still find it (P2, late-told). */
export const AS_OF_FEBRUARY = utc(2, 15);
/** "as of yesterday" (T-0089.2.6 adversary round, MINOR): a relative-date as-of phrase. parseTimePhrase's own
 * \byesterday\b handler (src/text/temporal.ts) currently turns this into a created-at window filter, not a Track 2
 * as-of read -- a gap its own comment defers to "T2 lane C". Lane C owns eval infrastructure, not the as-of
 * implementation (Track A, not yet merged), so this corpus names the case and reports it (subset:
 * phrase-relative-yesterday) rather than gating a fix that cannot exist yet. */
export const AS_OF_YESTERDAY = EVAL_NOW - DAY_MS;

/** The known-gap tag the month-day-name controls carried before T-0089.2.5 fixed the parser (no longer applied to
 * any query in this corpus); kept as a pinned fixture value for the gate-mechanics tests in temporal-gate.test.ts
 * and synthetic-acceptance.test.ts, so they and SYNTHETIC-CORPORA.md's history cannot drift apart. */
export const MONTH_DAY_CONTROL_GAP_TAG = "gap:temporal-month-day-controls";
/** T-0089.2.5's acceptance floor for that row, an absolute bar gate.ts's delta-based target-gaps rule cannot express
 * on its own (see SYNTHETIC-CORPORA.md); pinned here so the corpus test and the doc cannot drift apart. Enforced
 * mechanically now via CorpusSpec.floors (T-0089.2.6, gate.ts corpus-floors rule). */
export const MONTH_DAY_CONTROL_ACCEPTANCE_MRR = 0.95;
export const MONTH_DAY_CONTROL_FLOOR_SCOPE = "temporal [subset:control-not-asof]";

/** T-0089.2.3's target: knowledge-update's silent-contradiction subset, gated only through --target-subsets. */
export const KU_SILENT_TARGET = "knowledge-update:ku-silent";
/** T-0089.2.3's own staleness rule: a volatility:state row past this age is eligible for the penalty. Pinned here
 * so the corpus (silent-fresh/silent-true, adversary round 2) and staleDemote cannot drift apart on the number. */
export const STALE_THRESHOLD_DAYS = 90;

/** D-RET floors (T-0089.2.6 adversary round): the recorded baseline scores these four subsets 1.000/1.000/1.000
 * (or 0.500 for retracted-past's MRR, where "old" and the July as-of question legitimately compete against each
 * other), so a candidate that ignores D-RET's restore rule -- leaving a retracted belief's target permanently
 * hidden, or promoting the belief without restoring what it closed -- has room to fall through a delta-based rule
 * (nothing on the SAME side of the comparison to regress against) and still pass. Absolute bars, not deltas, so a
 * D-RET-ignoring candidate fails against the recorded baseline directly, per row, regardless of what it gains
 * elsewhere. Mins sit well below the honest baseline number but well above what a candidate that drops or
 * mis-ranks the gold document for these subsets would score. */
export const D_RET_FLOOR_RECALL10 = 0.9;
const D_RET_FLOORS: readonly { scope: string; mrrMin: number }[] = [
  { scope: "temporal-during [subset:retracted-past]", mrrMin: 0.35 },
  { scope: "temporal-during [subset:corrected-backdated]", mrrMin: 0.7 },
  { scope: "knowledge-update [subset:ku-corrected]", mrrMin: 0.7 },
  { scope: "knowledge-update [subset:ku-retracted]", mrrMin: 0.7 },
];

export function temporal(seed: number): CorpusSpec {
  const rand = rng(seed);
  const entries: CorpusEntry[] = [], queries: GoldenQuery[] = [], edges: CorpusEdge[] = [];
  const kinds: Kind[] = (Object.keys(TEMPORAL_TYPES) as Kind[]).flatMap(k => Array<Kind>(TEMPORAL_TYPES[k]).fill(k));
  const total = kinds.length;
  const brands = pseudoWords(total + 40, seed);
  const place = (i: number, k: number) => PLACES[(i * 3 + k * 17 + Math.floor(rand() * 2)) % PLACES.length];

  kinds.forEach((kind, i) => {
    const subject = `${brands[i]} ${THINGS[i % THINGS.length]}`;
    const cluster = `tm-${i}`;
    const A = place(i, 0), B = place(i, 1);
    const feb = utc(2, 1 + (i % 25));
    const id = (k: string) => `tm-${kind}-${i}-${k}`;
    const tags = (subset: string) => [`subset:${subset}`, `timeline:${kind}`];
    const q = (n: string, category: "temporal" | "temporal-during" | "knowledge-update", text: string, gold: Parameters<typeof query>[3], subset: string, extra: Partial<GoldenQuery> = {}) =>
      queries.push(query(`tm-q-${i}-${n}`, category, text, gold, { clusterKey: cluster, tags: tags(subset), ...extra }));
    const past = (gold: Parameters<typeof query>[3], month: string, asOf: number, phraseGold = gold) => {
      q("pre", "temporal", `Where was the ${subject} in ${month}?`, gold, "prefiltered", { asOf });
      q("date", "temporal", `Where was the ${subject} as of ${month} ${new Date(asOf).getUTCDate()}, 2026?`, phraseGold, "phrase-dated", { expectedAsOf: asOf });
    };
    /** Every temporal-during query carries asOfParam = expectedAsOf (14-t2-time-spec.md 6.2). */
    const during = (n: string, text: string, gold: Parameters<typeof query>[3], subset: string, asOf: number, extra: Partial<GoldenQuery> = {}) =>
      q(n, "temporal-during", text, gold, subset, { expectedAsOf: asOf, asOfParam: asOf, ...extra });

    if (kind === "update") {
      const jul = utc(7, 1 + (i % 25));
      entries.push(entry(id("old"), `On ${isoDay(feb)} the ${subject} was set up at ${A}.`, { createdAt: feb, validFrom: feb, validUntil: jul }));
      // Undated on purpose (cue balance, T-0089.2.6): during-after-change's gold must carry "is now" with no date, so
      // a "boost any document with an explicit date" shortcut cannot win by coincidence.
      entries.push(entry(id("new"), `The ${subject} is now at ${B}.`, { createdAt: jul, validFrom: jul }));
      edges.push(edge(id("new"), id("old")));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("new")], "current");
      past([id("old")], "April", AS_OF_APRIL);
      during("vague", `Where was the ${subject} during April?`, [id("old")], "during-before-change", AS_OF_APRIL);
      during("after", `Where was the ${subject} during August?`, [id("new")], "during-after-change", AS_OF_AUGUST);
      // Report-only (see AS_OF_YESTERDAY): exercises parseTimePhrase's existing \byesterday\b handler through the
      // query TEXT itself, the same path phrase-dated queries use (expectedAsOf only, audit-only, never a recall
      // param: asOfParam drives Track A's not-yet-merged explicit `asOf`, unrelated to this text-parsing gap).
      // Measured, not predicted: the recorded baseline scores this 0.000 across all 35 instances, rankedIds empty,
      // even though gold is in the pre-filter candidate pool -- "as of yesterday" narrows to a created-at window
      // nothing in the corpus lands in (its own document was created back in July), the exact created-at-filter
      // failure mode temporal.ts's own comment names. Not gated: no candidate exists yet whose fix this would
      // prove; it exists so C6's real implementation has a recorded number to be measured against.
      q("yesterday", "temporal", `Where is the ${subject} as of yesterday?`, [id("new")], "phrase-relative-yesterday", { expectedAsOf: AS_OF_YESTERDAY });
    } else if (kind === "retro") {
      const jun = utc(6, 1 + (i % 25)), aug = utc(8, 18 + (i % 4)), late = aug + 5 * 86_400_000;
      entries.push(entry(id("old"), `On ${isoDay(feb)} the ${subject} was set up at ${A}.`, { createdAt: feb, validFrom: feb, validUntil: jun }));
      // Written in August about a change that happened in June: the latest document by creation time is not the latest fact.
      entries.push(entry(id("new"), `The ${subject} moved to ${B} back in June.`, { createdAt: aug, validFrom: jun }));
      entries.push(entry(id("recap"), `Looking back through my notes, the ${subject} was at ${A} from February until June.`, { createdAt: late, validFrom: feb, validUntil: jun }));
      edges.push(edge(id("new"), id("old")), edge(id("new"), id("recap")));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("new")], "current");
      past([id("old")], "April", AS_OF_APRIL, [id("old"), id("recap")]);
      during("vague", `Where was the ${subject} during July?`, [id("new")], "backdated-past", AS_OF_JULY);
    } else if (kind === "retracted") {
      const jul = utc(7, 1 + (i % 12)), aug = utc(8, 10 + (i % 15));
      entries.push(entry(id("old"), `On ${isoDay(feb)} the ${subject} was set up at ${A}.`, { createdAt: feb, validFrom: feb }));
      // Actually-true semantics: the move never really happened, so "bad" declares an empty validity window (validUntil
      // equals validFrom, half-open and never valid) rather than one closed by the retraction. retractedAt still records
      // when the correction landed (aug), so the two fields answer different questions: was it ever true (no), and when
      // did we learn that (aug). D-RET (Rahil, 2026-09-27): retracting "bad" restores "old"'s validity, so "old" is
      // current again and "bad" is forbidden everywhere, never a second, lower-grade gold. Tagged status:deprecated:
      // a retraction runs deprecateEntry in production (T-0089.2.6 adversary round), and release/v4 recall already
      // excludes deprecated rows (search.ts:872) independent of Track 2, so the recorded baseline must reflect that
      // pre-existing behavior, not an unrealistic state where a retracted row still competes as an ordinary note.
      entries.push(entry(id("bad"), `The ${subject} moved to ${B} on ${isoDay(jul)}.`, { createdAt: jul, validFrom: jul, validUntil: jul, retractedAt: aug, tags: ["status:deprecated"] }));
      entries.push(entry(id("fix"), `Correction: the move of the ${subject} to ${B} was cancelled and it stays at ${A}.`, { createdAt: aug, validFrom: aug }));
      edges.push(edge(id("fix"), id("bad")));
      // Its own subset (not "current"): a D-RET floor needs to target this specific forbidden-bearing slice,
      // not the 180 plain "current" queries that share the tag but carry no forbidden id (T-0089.2.6 adversary round).
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("old"), id("fix")], "ku-retracted", { forbidden: [id("bad")] });
      past([id("old")], "April", AS_OF_APRIL);
      during("vague", `Where was the ${subject} during July?`, [id("old")], "retracted-past", AS_OF_LATE_JULY, { forbidden: [id("bad")] });
    } else if (kind === "retro-norecap") {
      // Like retro, but with no recap note at all: gold is the newest document by creation AND the only document
      // valid at the as-of date, created after it. A created_at-only as-of implementation excludes it (P2).
      const jun = utc(6, 1 + (i % 20)), aug = utc(8, 15 + (i % 10));
      entries.push(entry(id("old"), `On ${isoDay(feb)} the ${subject} was set up at ${A}.`, { createdAt: feb, validFrom: feb, validUntil: jun }));
      entries.push(entry(id("new"), `The ${subject} moved to ${B} back in June.`, { createdAt: aug, validFrom: jun }));
      edges.push(edge(id("new"), id("old")));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("new")], "current");
      during("vague", `Where was the ${subject} during July?`, [id("new")], "backdated-newest", AS_OF_JULY);
    } else if (kind === "corrected") {
      // Wrong from the start (an authority problem, not a validity one), so "wrong" declares an empty window like
      // "bad" above. The correction states it was always true from Jan, so as-of Feb finds it despite being written
      // in March (P2, late-told): the "Correction" wording and the after-T creation time must not cost it the rank.
      // Tagged status:deprecated for the same reason as "bad" above.
      const jan = utc(1, 1 + (i % 20)), mar = utc(3, 5 + (i % 20));
      entries.push(entry(id("wrong"), `The ${subject} is at ${A}.`, { createdAt: jan, validFrom: jan, validUntil: jan, retractedAt: mar, tags: ["status:deprecated"] }));
      entries.push(entry(id("correction"), `Correction: the ${subject} has always been at ${B}, not ${A}.`, { createdAt: mar, validFrom: jan }));
      edges.push(edge(id("correction"), id("wrong")));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("correction")], "ku-corrected", { forbidden: [id("wrong")] });
      during("vague", `Where was the ${subject} during February?`, [id("correction")], "corrected-backdated", AS_OF_FEBRUARY, { forbidden: [id("wrong")] });
    } else if (kind === "recap-only") {
      // The recap is the only document valid at the as-of date (its window ends exactly when "new" begins, so the
      // two are disjoint, not superseding), and it is also the newest by creation: a "demote the newest document"
      // shortcut and a "created after T" penalty must both fail here, not just pass by omission.
      const jun = utc(6, 1 + (i % 20)), aug = utc(8, 1 + (i % 10)), late = aug + 5 * 86_400_000, feb2 = utc(2, 1 + (i % 20));
      entries.push(entry(id("new"), `The ${subject} is now at ${B}, moved in June.`, { createdAt: aug, validFrom: jun }));
      entries.push(entry(id("recap"), `Looking back through my notes, the ${subject} was at ${A} from February until June.`, { createdAt: late, validFrom: feb2, validUntil: jun }));
      edges.push(edge(id("new"), id("recap")));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("new")], "current");
      during("vague", `Where was the ${subject} during April?`, [id("recap")], "recap-gold", AS_OF_APRIL);
    } else if (kind === "silent") {
      // No supersede edge at all: the contradiction was never detected, so there is genuinely no structural signal
      // to disambiguate "old" from "new" -- that lack of a signal is the point of this shape, and is why plain
      // semantic ranking has real headroom to get it wrong (30/30 at baseline, adversary round; a direct statement
      // read as more confidently current than a hedged, unconfirmed one, regardless of which one is stale). "old"
      // is a state-volatility fact past the 90-day staleness threshold at EVAL_NOW (2026-09-01); only staleness
      // (T-0089.2.3), not structure, can fix this. No temporal-during query: targets ku-silent only.
      const may = utc(5, 10 + (i % 20)), jul = utc(7, 1 + (i % 20));
      entries.push(entry(id("old"), `The ${subject} is at ${A}.`, { createdAt: may, tags: ["volatility:state"] }));
      entries.push(entry(id("new"), `Heard secondhand that the ${subject} may have moved to ${B}; meant to double check but have not yet.`, { createdAt: jul }));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("new")], "ku-silent");
    } else if (kind === "silent-fresh") {
      // Adversary round 2 (T-0089.2.6): the same shape as "silent", except "old" is UNDER the 90-day staleness
      // threshold at EVAL_NOW (2026-09-01), so gold stays "old" -- an age-blind penalty that demotes any
      // volatility:state row regardless of how old it is has real room to lose here, and the hedge/secondhand
      // wording sits on "new", which is NOT gold, so a wording shortcut that just promotes hedge phrasing loses too.
      const augOld = utc(8, 1 + (i % 12)), augNew = utc(8, 14 + (i % 12));
      entries.push(entry(id("old"), `The ${subject} is at ${A}.`, { createdAt: augOld, tags: ["volatility:state"] }));
      entries.push(entry(id("new"), `Heard secondhand that the ${subject} may have moved to ${B}; meant to double check but have not yet.`, { createdAt: augNew }));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("old")], "ku-silent-fresh");
    } else if (kind === "silent-true") {
      // Adversary round 2 (T-0089.2.6): a lone state fact, past the 90-day staleness threshold, with no rival at
      // all in its own timeline -- gold, but stale and unsuperseded, so R4's concern ("no stale-but-still-true
      // gold exists") has a real instance, and a penalty that demotes any volatility:state row past the age
      // threshold regardless of whether a rival exists (rather than only when one does) still has room to lose.
      const may = utc(5, 10 + (i % 20));
      entries.push(entry(id("old"), `The ${subject} is at ${A}.`, { createdAt: may, tags: ["volatility:state"] }));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("old")], "ku-silent-true");
    } else {
      const aug = utc(8, 5 + (i % 20));
      entries.push(entry(id("only"), `The ${subject} is at ${A}. Edited on ${isoDay(aug)}: the entrance is now on the ${pick(rand, KINDS)} side.`, {
        createdAt: feb, updatedAt: aug, validFrom: feb,
        priorVersions: [{ at: feb, content: `The ${subject} is at ${A}.` }],
      }));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("only")], "current");
      past([id("only")], "April", AS_OF_APRIL);
    }
  });

  // Controls: a month and day inside a name. A date parser that reads them as a question date filters the wrong
  // documents. T-0089.2.5 fixed the shipped parser to recognize a month-day match followed by a proper noun as a
  // name, not a date, so these now score correctly (recall@10/MRR@10 1.000) and join the ordinary "temporal"
  // category's regression rule via subset:control-not-asof like any other subset (no gap tag needed). The floor
  // below (T-0089.2.6) is the mechanical enforcement of T-0089.2.5's acceptance bar.
  for (let c = 0; c < 30; c++) {
    const [m, d] = MONTH_DAY_NAMES[c % MONTH_DAY_NAMES.length];
    const name = `${m} ${d} ${brands[total + (c % 40)]} Cafe`;
    const at = utc(1 + ((c * 5) % 12), 20 + (c % 8));
    const ident = `tm-control-${c}`;
    entries.push(entry(ident, `The ${name} on ${PLACES[(c * 7) % PLACES.length]} opens at nine and closes at five.`, { createdAt: at, validFrom: at }));
    queries.push(query(`tm-q-control-${c}`, "temporal", `What time does the ${name} open?`, [ident], { clusterKey: `tm-control-${c}`, tags: ["subset:control-not-asof", "timeline:control"] }));
  }

  // Distractors that share the category nouns but belong to no timeline.
  const others = pseudoWords(60, seed + 9).filter(w => !brands.includes(w));
  for (let f = 0; f < 300; f++) {
    const at = utc(1 + (f % 8), 1 + ((f * 3) % 27));
    entries.push(entry(`tm-filler-${f}`, `Reminder: the ${THINGS[f % THINGS.length]} paperwork for ${others[(f * 7) % others.length]} Holdings is due on ${isoDay(at + 9 * 86_400_000)}. ${pick(rand, ["Bring the signed copy.", "Ask for a receipt.", "Confirm the price first.", "Keep the reference number."])}`, { createdAt: at }));
  }
  const spec = finish("temporal", seed, entries, queries, edges);
  return {
    ...spec,
    floors: [
      { scope: MONTH_DAY_CONTROL_FLOOR_SCOPE, metric: "mrr10", min: MONTH_DAY_CONTROL_ACCEPTANCE_MRR },
      ...D_RET_FLOORS.flatMap(({ scope, mrrMin }) => [
        { scope, metric: "recall10" as const, min: D_RET_FLOOR_RECALL10 },
        { scope, metric: "mrr10" as const, min: mrrMin },
      ]),
    ],
  };
}
