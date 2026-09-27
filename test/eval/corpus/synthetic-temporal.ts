import type { GoldenQuery } from "../types";
import { edge, entry, finish, isoDay, pick, pseudoWords, query, rng, utc } from "./synthetic-common";
import type { CorpusEdge, CorpusEntry, CorpusSpec } from "./types";

const THINGS = ["studio lease", "supplier", "support hotline", "backup provider", "delivery depot", "meeting room", "billing address", "training venue", "design agency", "weekly pickup", "storage unit", "parking permit"];
const STREETS = ["Maple", "Amber", "Harbor", "Cedar", "Willow", "Granite", "Linden", "Copper", "Juniper", "Aspen", "Birch", "Slate", "Falcon", "Meadow", "Summit", "Orchard", "Ridge", "Lantern", "Marble", "Prairie"];
const KINDS = ["Street", "Court", "Wharf", "Lane"];
const PLACES = STREETS.flatMap(s => KINDS.map(k => `${s} ${k}`));
const MONTH_DAY_NAMES = [["Aug", 8], ["Jun", 3], ["Apr", 12], ["Jul", 21], ["Mar", 9], ["May", 17], ["Oct", 5], ["Nov", 14], ["Dec", 2], ["Feb", 26]] as const;

/**
 * Timeline shapes (T-0089.2.6 adds the last four to fix round-4's shortcut-friendly gold, 14-t2-time-spec.md 6.2).
 * update: plain change, gold split into a before/after pair. retro: backdated and retrospective notes, gold in the
 * middle. retracted: a fact later withdrawn, then the withdrawal itself retracted (D-RET restores it). edited: one
 * document edited after the as-of date. retro-norecap: backdated with no recap note, so gold is the newest document
 * and created after the as-of date. corrected: wrong from the start, corrected later; gold is newest, forbidden is
 * the original. recap-only: the recap is the only valid document at the as-of date, and also the newest by creation.
 * silent: a contradiction the loader never linked with an edge, so nothing but staleness can favor the new fact.
 */
export const TEMPORAL_TYPES = { update: 35, retro: 35, retracted: 30, edited: 20, "retro-norecap": 30, corrected: 30, "recap-only": 30, silent: 30 } as const;
type Kind = keyof typeof TEMPORAL_TYPES;

/** The dates the past questions are asked about. */
export const AS_OF_APRIL = utc(4, 15);
export const AS_OF_JULY = utc(7, 10);
export const AS_OF_LATE_JULY = utc(7, 20);
/** during-after-change (T-0089.2.6): after the update kind's own supersede, so gold is the newest document. */
export const AS_OF_AUGUST = utc(8, 20);
/** corrected-backdated (T-0089.2.6): before the correction was written, so as-of must still find it (P2, late-told). */
export const AS_OF_FEBRUARY = utc(2, 15);

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
      // current again and "bad" is forbidden everywhere, never a second, lower-grade gold.
      entries.push(entry(id("bad"), `The ${subject} moved to ${B} on ${isoDay(jul)}.`, { createdAt: jul, validFrom: jul, validUntil: jul, retractedAt: aug }));
      entries.push(entry(id("fix"), `Correction: the move of the ${subject} to ${B} was cancelled and it stays at ${A}.`, { createdAt: aug, validFrom: aug }));
      edges.push(edge(id("fix"), id("bad")));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("old"), id("fix")], "current", { forbidden: [id("bad")] });
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
      const jan = utc(1, 1 + (i % 20)), mar = utc(3, 5 + (i % 20));
      entries.push(entry(id("wrong"), `The ${subject} is at ${A}.`, { createdAt: jan, validFrom: jan, validUntil: jan, retractedAt: mar }));
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
      // No supersede edge at all: the contradiction was never detected. "old" is a state-volatility fact aged well
      // past the 90-day staleness threshold at EVAL_NOW (2026-09-01), so only staleness (T-0089.2.3), not structure,
      // can favor "new". No temporal-during query: this kind targets knowledge-update's ku-silent subset only.
      const mar = utc(3, 1 + (i % 25)), aug2 = utc(8, 1 + (i % 20));
      entries.push(entry(id("old"), `The ${subject} uses ${A}.`, { createdAt: mar, tags: ["volatility:state"] }));
      entries.push(entry(id("new"), `The ${subject} switched to ${B}.`, { createdAt: aug2 }));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("new")], "ku-silent");
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
  return { ...spec, floors: [{ scope: MONTH_DAY_CONTROL_FLOOR_SCOPE, metric: "mrr10", min: MONTH_DAY_CONTROL_ACCEPTANCE_MRR }] };
}
