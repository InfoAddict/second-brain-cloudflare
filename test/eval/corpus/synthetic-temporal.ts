import type { GoldenQuery } from "../types";
import { edge, entry, finish, isoDay, pick, pseudoWords, query, rng, utc } from "./synthetic-common";
import type { CorpusEdge, CorpusEntry, CorpusSpec } from "./types";

const THINGS = ["studio lease", "supplier", "support hotline", "backup provider", "delivery depot", "meeting room", "billing address", "training venue", "design agency", "weekly pickup", "storage unit", "parking permit"];
const STREETS = ["Maple", "Amber", "Harbor", "Cedar", "Willow", "Granite", "Linden", "Copper", "Juniper", "Aspen", "Birch", "Slate", "Falcon", "Meadow", "Summit", "Orchard", "Ridge", "Lantern", "Marble", "Prairie"];
const KINDS = ["Street", "Court", "Wharf", "Lane"];
const PLACES = STREETS.flatMap(s => KINDS.map(k => `${s} ${k}`));
const MONTH_DAY_NAMES = [["Aug", 8], ["Jun", 3], ["Apr", 12], ["Jul", 21], ["Mar", 9], ["May", 17], ["Oct", 5], ["Nov", 14], ["Dec", 2], ["Feb", 26]] as const;

/** Timeline shapes. update: plain change. retro: backdated and retrospective notes. retracted: a fact later withdrawn. edited: one document edited after the as-of date. */
export const TEMPORAL_TYPES = { update: 35, retro: 35, retracted: 30, edited: 20 } as const;
type Kind = keyof typeof TEMPORAL_TYPES;

/** The dates the past questions are asked about. */
export const AS_OF_APRIL = utc(4, 15);
export const AS_OF_JULY = utc(7, 10);
export const AS_OF_LATE_JULY = utc(7, 20);

/** Tag that removes the month-day-name controls from the temporal category's regression and improvement rows (see
 * below); pinned in a corpus test alongside SYNTHETIC-CORPORA.md so the two cannot drift apart. */
export const MONTH_DAY_CONTROL_GAP_TAG = "gap:temporal-month-day-controls";
/** T-0089.2.5's acceptance floor for that row, an absolute bar gate.ts's delta-based target-gaps rule cannot express
 * on its own (see SYNTHETIC-CORPORA.md); pinned here so the corpus test and the doc cannot drift apart. */
export const MONTH_DAY_CONTROL_ACCEPTANCE_MRR = 0.95;

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

    if (kind === "update") {
      const jul = utc(7, 1 + (i % 25));
      entries.push(entry(`${id("old")}`, `On ${isoDay(feb)} the ${subject} was set up at ${A}.`, { createdAt: feb, validFrom: feb, validUntil: jul }));
      entries.push(entry(id("new"), `The ${subject} is now at ${B}, moved on ${isoDay(jul)}.`, { createdAt: jul, validFrom: jul }));
      edges.push(edge(id("new"), id("old")));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("new")], "current");
      past([id("old")], "April", AS_OF_APRIL);
      q("vague", "temporal-during", `Where was the ${subject} during April?`, [id("old")], "phrase-vague", { expectedAsOf: AS_OF_APRIL });
    } else if (kind === "retro") {
      const jun = utc(6, 1 + (i % 25)), aug = utc(8, 18 + (i % 4)), late = aug + 5 * 86_400_000;
      entries.push(entry(id("old"), `On ${isoDay(feb)} the ${subject} was set up at ${A}.`, { createdAt: feb, validFrom: feb, validUntil: jun }));
      // Written in August about a change that happened in June: the latest document by creation time is not the latest fact.
      entries.push(entry(id("new"), `The ${subject} moved to ${B} back in June.`, { createdAt: aug, validFrom: jun }));
      entries.push(entry(id("recap"), `Looking back through my notes, the ${subject} was at ${A} from February until June.`, { createdAt: late, validFrom: feb, validUntil: jun }));
      edges.push(edge(id("new"), id("old")), edge(id("new"), id("recap")));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("new")], "current");
      past([id("old")], "April", AS_OF_APRIL, [id("old"), id("recap")]);
      q("vague", "temporal-during", `Where was the ${subject} during July?`, [id("new")], "backdated-past", { expectedAsOf: AS_OF_JULY });
    } else if (kind === "retracted") {
      const jul = utc(7, 1 + (i % 12)), aug = utc(8, 10 + (i % 15));
      entries.push(entry(id("old"), `On ${isoDay(feb)} the ${subject} was set up at ${A}.`, { createdAt: feb, validFrom: feb }));
      // Actually-true semantics: the move never really happened, so "bad" declares an empty validity window (validUntil
      // equals validFrom, half-open and never valid) rather than one closed by the retraction. retractedAt still records
      // when the correction landed (aug), so the two fields answer different questions: was it ever true (no), and when
      // did we learn that (aug). Whether a shipped implementation should instead model "later retracted" as its own
      // status distinct from an empty valid_until window is Track 2's decision, not this corpus's; see the docs.
      entries.push(entry(id("bad"), `The ${subject} moved to ${B} on ${isoDay(jul)}.`, { createdAt: jul, validFrom: jul, validUntil: jul, retractedAt: aug }));
      entries.push(entry(id("fix"), `Correction: the move of the ${subject} to ${B} was cancelled and it stays at ${A}.`, { createdAt: aug, validFrom: aug }));
      edges.push(edge(id("fix"), id("bad")));
      q("now", "knowledge-update", `Where is the ${subject} now?`, [id("old"), id("fix")], "current");
      past([id("old")], "April", AS_OF_APRIL);
      // Gold is the actually-true answer only (old): recallAtK and mrrAtK ignore grade, so a second, lower-grade gold
      // id would let a system that ranks the cancelled move ("bad") first pass just as well as one that ranks the
      // actually-true answer first. "bad" surfacing is reported as a diagnostic (see synthetic-report.ts), not as gold.
      q("vague", "temporal-during", `Where was the ${subject} during July?`, [id("old")], "retracted-past", { expectedAsOf: AS_OF_LATE_JULY });
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

  // Controls: a month and day inside a name. A date parser that reads them as a question date filters the wrong documents.
  // Today's shipped parser already misreads these (baseline 0/0), so a delta-from-baseline rule can never see a candidate
  // break them further: both score 0. Tagged "gap:temporal-month-day-controls" so the gate's known-gap population excludes
  // them from the temporal category's regression and improvement rows entirely (a gap query at baseline 0 cannot regress
  // and would only dilute the rule; see gate.ts), instead of silently netting against a real as-of gain. They stay visible
  // as their own row in "known gaps" and in the subset diagnostics: read them there, not through --target temporal.
  for (let c = 0; c < 30; c++) {
    const [m, d] = MONTH_DAY_NAMES[c % MONTH_DAY_NAMES.length];
    const name = `${m} ${d} ${brands[total + (c % 40)]} Cafe`;
    const at = utc(1 + ((c * 5) % 12) , 20 + (c % 8));
    const ident = `tm-control-${c}`;
    entries.push(entry(ident, `The ${name} on ${PLACES[(c * 7) % PLACES.length]} opens at nine and closes at five.`, { createdAt: at, validFrom: at }));
    queries.push(query(`tm-q-control-${c}`, "temporal", `What time does the ${name} open?`, [ident], { clusterKey: `tm-control-${c}`, tags: ["subset:control-not-asof", "timeline:control", MONTH_DAY_CONTROL_GAP_TAG] }));
  }

  // Distractors that share the category nouns but belong to no timeline.
  const others = pseudoWords(60, seed + 9).filter(w => !brands.includes(w));
  for (let f = 0; f < 300; f++) {
    const at = utc(1 + (f % 8), 1 + ((f * 3) % 27));
    entries.push(entry(`tm-filler-${f}`, `Reminder: the ${THINGS[f % THINGS.length]} paperwork for ${others[(f * 7) % others.length]} Holdings is due on ${isoDay(at + 9 * 86_400_000)}. ${pick(rand, ["Bring the signed copy.", "Ask for a receipt.", "Confirm the price first.", "Keep the reference number."])}`, { createdAt: at }));
  }
  return finish("temporal", seed, entries, queries, edges);
}
