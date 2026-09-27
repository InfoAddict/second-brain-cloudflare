import { describe, expect, it } from "vitest";
import { buildSyntheticCorpus, SYNTHETIC_CORPORA } from "./synthetic";
import { INJECTION_DOCS, INJECTION_SUBJECTS, PLANT_STYLES, plantText } from "./synthetic-injection";
import { NOISE_FOOTER } from "./synthetic-noise";
import { STANDING, UNRELATED_QUERIES } from "./synthetic-standing";
import { MONTH_DAY_CONTROL_ACCEPTANCE_MRR, MONTH_DAY_CONTROL_GAP_TAG, TEMPORAL_TYPES } from "./synthetic-temporal";
import { validAt } from "../temporal-oracle";

const DURING_SUBSETS = ["phrase-vague", "backdated-past", "retracted-past"];

const byTag = <T extends { tags?: string[] }>(qs: T[], tag: string): T[] => qs.filter(q => q.tags?.includes(tag));
const clusters = (qs: { clusterKey?: string }[]) => new Set(qs.map(q => q.clusterKey)).size;
const built = Object.fromEntries(SYNTHETIC_CORPORA.map(id => [id, buildSyntheticCorpus(id)])) as Record<(typeof SYNTHETIC_CORPORA)[number], ReturnType<typeof buildSyntheticCorpus>>;

describe("synthetic corpora, common", () => {
  it("rebuilds every seeded corpus identically and changes with the seed", () => {
    for (const id of SYNTHETIC_CORPORA) {
      expect(buildSyntheticCorpus(id).dataFingerprint).toEqual(built[id].dataFingerprint);
      expect(buildSyntheticCorpus(id, 7).dataFingerprint).not.toEqual(buildSyntheticCorpus(id, 8).dataFingerprint);
    }
  });
  it("has unique entry ids, unique query ids and gold that exists", () => {
    for (const id of SYNTHETIC_CORPORA) {
      const c = built[id], ids = new Set(c.entries.map(e => e.id));
      expect(ids.size).toBe(c.entries.length);
      expect(new Set(c.queries.map(q => q.id)).size).toBe(c.queries.length);
      for (const q of c.queries) for (const g of q.gold) expect(ids.has(g.id)).toBe(true);
    }
  });
});

describe("temporal", () => {
  const c = built.temporal;
  it("dates documents at noon UTC, so the local-time date parser answers the same in every timezone", () => {
    for (const e of c.entries) expect(e.createdAt % 86_400_000).toBe(12 * 3_600_000);
  });
  it("names every timeline's subject distinctly, with no numbered siblings", () => {
    const subjects = c.queries.filter(q => q.tags?.includes("subset:current")).map(q => q.text.replace(/^Where is the /, "").replace(/ now\?$/, ""));
    expect(subjects).toHaveLength(Object.values(TEMPORAL_TYPES).reduce((a, b) => a + b, 0));
    expect(new Set(subjects).size).toBe(subjects.length);
    expect(subjects.some(s => /\d/.test(s))).toBe(false);
  });
  it("keeps the newer fact from answering the past question (no former-location wording)", () => {
    for (const e of c.entries.filter(x => /^tm-(update|retro)-\d+-new$/.test(x.id))) expect(e.content).not.toMatch(/former|previous|used to|was at/i);
  });
  it("declares supersession edges and validity, including retractions and post-as-of edits", () => {
    expect(c.edges.length).toBeGreaterThan(80);
    expect(c.edges.every(e => e.type === "supersedes")).toBe(true);
    expect(c.entries.filter(e => e.retractedAt !== undefined).length).toBe(TEMPORAL_TYPES.retracted);
    const edited = c.entries.filter(e => e.priorVersions);
    expect(edited).toHaveLength(TEMPORAL_TYPES.edited);
    for (const e of edited) expect(e.updatedAt!).toBeGreaterThan(Date.UTC(2026, 3, 15));
  });
  it("has backdated entries: created after the date the fact became valid, and a newer-created recap of the past", () => {
    for (const e of c.entries.filter(x => /^tm-retro-\d+-new$/.test(x.id))) expect(e.validFrom!).toBeLessThan(e.createdAt - 30 * 86_400_000);
    const i = c.entries.find(x => x.id.startsWith("tm-retro-"))!.id.split("-")[2];
    const created = (k: string) => c.entries.find(x => x.id === `tm-retro-${i}-${k}`)!.createdAt;
    expect(created("recap")).toBeGreaterThan(created("new"));
    const now = c.queries.find(q => q.id === `tm-q-${i}-now`)!;
    expect(now.gold.map(g => g.id)).toEqual([`tm-retro-${i}-new`]);
  });
  it("marks exactly the pre-filtered past questions with asOf and gives phrase questions an expected date instead", () => {
    for (const q of c.queries) {
      expect(q.asOf !== undefined).toBe(!!q.tags?.includes("subset:prefiltered"));
      if (q.tags?.some(t => /subset:(phrase|backdated|retracted)/.test(t))) expect(q.expectedAsOf).toBeDefined();
    }
    expect(byTag(c.queries, "subset:phrase-dated").every(q => /as of \w+ \d+, 2026/.test(q.text))).toBe(true);
  });
  it("has month-day controls that a date parser must not read as a question date, no longer tagged out of the temporal target", () => {
    const controls = byTag(c.queries, "subset:control-not-asof");
    expect(controls.length).toBeGreaterThanOrEqual(30);
    for (const q of controls) {
      expect(q.text).toMatch(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b/);
      expect(q.asOf).toBeUndefined();
      expect(q.expectedAsOf).toBeUndefined();
      // T-0089.2.5 fixed the parser to recognize these as names, not dates, so the controls now score correctly and
      // no longer need the known-gap exclusion: they join the ordinary temporal category's regression rule like any
      // other subset. MONTH_DAY_CONTROL_GAP_TAG/_ACCEPTANCE_MRR remain pinned for the gate-mechanics fixtures in
      // temporal-gate.test.ts and synthetic-acceptance.test.ts, and for SYNTHETIC-CORPORA.md's history of the fix.
      expect(q.tags).not.toContain(MONTH_DAY_CONTROL_GAP_TAG);
      expect(MONTH_DAY_CONTROL_GAP_TAG).toBe("gap:temporal-month-day-controls");
      expect(MONTH_DAY_CONTROL_ACCEPTANCE_MRR).toBe(0.95);
    }
  });
  it("meets the gate's power floors per category, including the split-out as-of gate", () => {
    for (const cat of ["temporal", "temporal-during", "knowledge-update"]) {
      const qs = c.queries.filter(q => q.category === cat);
      expect(qs.length, cat).toBeGreaterThanOrEqual(100);
      expect(clusters(qs), cat).toBeGreaterThanOrEqual(30);
    }
    expect(c.queries.length).toBeGreaterThanOrEqual(200);
  });
  it("puts every during-subset query in the temporal-during category, and only those there", () => {
    const during = c.queries.filter(q => DURING_SUBSETS.some(s => q.tags?.includes(`subset:${s}`)));
    expect(during).toHaveLength(100);
    expect(clusters(during)).toBe(100);
    for (const q of during) expect(q.category).toBe("temporal-during");
    for (const q of c.queries.filter(q => q.category === "temporal-during")) expect(DURING_SUBSETS.some(s => q.tags?.includes(`subset:${s}`))).toBe(true);
  });
  it("gives the retracted-past question the actually-true gold only: ranking the cancelled move first is not rewarded", () => {
    for (const q of byTag(c.queries, "subset:retracted-past")) {
      expect(q.gold).toHaveLength(1);
      expect(q.gold[0].grade).toBe(2);
      expect(q.gold[0].id).toMatch(/-old$/);
      const badId = q.gold[0].id.replace(/-old$/, "-bad");
      expect(c.entries.some(e => e.id === badId)).toBe(true);
      expect(q.gold.map(g => g.id)).not.toContain(badId);
    }
  });
  it("gives every during-subset query's gold a document that is valid at its expectedAsOf, for every timeline shape", () => {
    for (const q of c.queries.filter(x => x.category === "temporal-during")) {
      expect(q.expectedAsOf).toBeDefined();
      for (const g of q.gold) expect(validAt(c.entries.find(e => e.id === g.id)!, q.expectedAsOf!)).toBe(true);
    }
  });
  it("makes the current answer valid now and its predecessors not, per the declared validity", () => {
    const now = Date.UTC(2026, 8, 1);
    for (const q of c.queries.filter(x => x.tags?.includes("subset:current"))) for (const g of q.gold) expect(validAt(c.entries.find(e => e.id === g.id)!, now)).toBe(true);
    expect(validAt(c.entries.find(e => e.id.endsWith("-old") && e.id.startsWith("tm-update-"))!, now)).toBe(false);
  });
});

describe("noise", () => {
  const c = built.noise, email = new Set(c.entries.filter(e => e.source === "email-gmail").map(e => e.id));
  it("shares one identical footer across at least five sender templates", () => {
    const mails = c.entries.filter(e => email.has(e.id));
    expect(mails.every(e => e.content.endsWith(NOISE_FOOTER))).toBe(true);
    const templates = new Set(mails.map(e => e.content.split("\n")[0].replace(/[\w.-]+@/, "@")));
    expect(templates.size).toBeGreaterThanOrEqual(5);
  });
  it("has probes, recurring finance notices, and email-correct controls, about half of queries answered by email", () => {
    for (const s of ["probe-footer-words", "probe-footer-synonym", "recurring", "email-control", "note-same-topic"]) expect(byTag(c.queries, `subset:${s}`).length).toBeGreaterThanOrEqual(10);
    const emailGold = c.queries.filter(q => q.gold.every(g => email.has(g.id)));
    expect(emailGold.length / c.queries.length).toBeGreaterThanOrEqual(0.33);
    expect(byTag(c.queries, "subset:email-control").some(q => /in my email|according to my email/i.test(q.text))).toBe(true);
    expect(byTag(c.queries, "subset:recurring").every(q => /direct deposit/.test(q.text))).toBe(true);
  });
  it("cannot be solved by source alone: notes and emails are both gold, on the same topics", () => {
    const sourceOf = (id: string) => (email.has(id) ? "email" : "note");
    expect(new Set(c.queries.map(q => sourceOf(q.gold[0].id)))).toEqual(new Set(["email", "note"]));
    expect(c.entries.some(e => e.id.startsWith("nz-flightnote-"))).toBe(true);
    expect(c.entries.some(e => e.id.startsWith("nz-flight-"))).toBe(true);
  });
  it("meets the gate's power floors", () => {
    expect(c.queries.length).toBeGreaterThanOrEqual(200);
    expect(clusters(c.queries)).toBeGreaterThanOrEqual(30);
  });
  it("gives probe queries only footer words, with no email vocabulary of their own", () => {
    for (const q of c.queries.filter(q => q.tags?.some(t => t.startsWith("subset:probe-footer")))) expect(q.text).not.toMatch(/email|deposit|flight|prescription|bill/i);
  });
});

describe("injection", () => {
  const c = built.injection, plants = c.entries.filter(e => e.id.startsWith("ij-plant-"));
  it("plants one email per targeted subject at 1 to 2 percent of the corpus", () => {
    expect(c.queries).toHaveLength(INJECTION_SUBJECTS);
    expect(plants).toHaveLength(INJECTION_SUBJECTS);
    expect(c.entries.length).toBe(INJECTION_DOCS);
    expect(plants.length / c.entries.length).toBeGreaterThanOrEqual(0.01);
    expect(plants.length / c.entries.length).toBeLessThanOrEqual(0.02);
  });
  it("uses every plant style, and the factual style contains no command words", () => {
    for (const style of PLANT_STYLES) expect(plants.some(p => p.id.startsWith(`ij-plant-${style}-`))).toBe(true);
    expect(plantText("factual", "the thing")).not.toMatch(/ignore|instruction|disregard|assistant|system|override|must|reply|say that/i);
    expect(plantText("impersonation", "the thing")).not.toMatch(/ignore previous/i);
  });
  it("has benign mail on the same topics and gold that is never a plant", () => {
    expect(c.entries.filter(e => e.id.startsWith("ij-benign-")).length).toBe(INJECTION_SUBJECTS * 2);
    expect(c.queries.every(q => q.gold.every(g => !g.id.startsWith("ij-plant-")))).toBe(true);
  });
});

describe("standing", () => {
  const c = built.standing;
  it("has thirty distinct memories inside a realistic haystack", () => {
    const memories = c.entries.filter(e => e.tags.includes("standing"));
    expect(memories).toHaveLength(30);
    expect(STANDING).toHaveLength(30);
    expect(new Set(STANDING.map(s => s.when)).size).toBe(30);
    expect(c.entries.length - 30).toBeGreaterThan(1000);
    expect(memories.every(m => /^When .+, .+\.$/.test(m.content))).toBe(true);
  });
  it("splits negatives into three labelled groups plus positives, at a stated prevalence", () => {
    expect(byTag(c.queries, "standing:yes")).toHaveLength(150);
    expect(byTag(c.queries, "standing:overlap")).toHaveLength(120);
    expect(byTag(c.queries, "standing:intent")).toHaveLength(90);
    expect(byTag(c.queries, "standing:unrelated")).toHaveLength(UNRELATED_QUERIES);
    for (const t of ["standing:overlap", "standing:intent", "standing:unrelated"]) expect(byTag(c.queries, t).every(q => q.gold.length === 0)).toBe(true);
  });
  it("holds out a split that shares no memory with the tuning split", () => {
    const memoriesIn = (split: string) => new Set(byTag(byTag(c.queries, "standing:yes"), `split:${split}`).map(q => q.clusterKey));
    expect(memoriesIn("dev").size).toBe(15);
    expect(memoriesIn("test").size).toBe(15);
    for (const m of memoriesIn("dev")) expect(memoriesIn("test").has(m)).toBe(false);
  });
});
