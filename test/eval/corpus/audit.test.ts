import { describe, expect, it } from "vitest";
import { auditQueries, haystackVocabulary } from "./audit";
import { ACTORS, EVAL_NOW, WORKSPACES, type CorpusEdge, type CorpusEntry } from "./types";
import type { GoldenQuery } from "../types";

const entry = (id: string, content: string, workspace: keyof typeof WORKSPACES = "avery"): CorpusEntry => ({
  id, content, tags: [], source: "api", createdAt: EVAL_NOW,
  workspaceId: WORKSPACES[workspace], actorId: ACTORS.avery,
});
const query = (over: Partial<GoldenQuery> & Pick<GoldenQuery, "id" | "category" | "text">): GoldenQuery => ({
  gold: [{ id: "g", grade: 2 }], viewer: "avery", ...over,
});
const rules = (entries: CorpusEntry[], queries: GoldenQuery[], edges: CorpusEdge[] = []) =>
  auditQueries({ entries, edges, queries }).map(finding => `${finding.queryId}:${finding.rule}`);
const filler = Array.from({ length: 40 }, (_, i) => entry(`f${i}`, `weekly review notes about budget planning number ${i}`));

describe("auditQueries", () => {
  it("requires the exact identifier in the query and gold, including token boundaries", () => {
    const gold = entry("g", "Invoice dispute INV-88213 was settled");
    expect(rules([...filler, gold], [query({ id: "ok", category: "identifier", text: "INV-88213" })])).toEqual([]);
    expect(rules([...filler, gold], [query({ id: "wrong", category: "identifier", text: "INV-99999" })])).toContain("wrong:identifier-not-in-gold");
    expect(rules([...filler, entry("g", "Invoice INV-88213X was settled")], [query({ id: "partial", category: "identifier", text: "INV-88213" })])).toContain("partial:identifier-not-in-gold");
    expect(rules([...filler, gold], [query({ id: "absent", category: "identifier", text: "invoice dispute" })])).toContain("absent:identifier-no-token");
    const repeats = Array.from({ length: 6 }, (_, i) => entry(`repeat-${i}`, `Another invoice INV-88213, copy ${i}`));
    expect(rules([...filler, gold, ...repeats], [query({ id: "flooded", category: "identifier", text: "INV-88213" })])).toContain("flooded:identifier-too-common");
    expect(rules([entry("g", "Invoice dispute INV-88213. settled")], [query({ id: "dot", category: "identifier", text: "INV-88213." })])).toEqual([]);
    for (const text of ["well-known", "decide.", "2027"]) {
      expect(rules([entry("g", text)], [query({ id: "ordinary", category: "identifier", text })])).toContain("ordinary:identifier-no-token");
    }
  });

  it("catches lexical leakage in paraphrases while accepting low-overlap wording", () => {
    const gold = entry("g", "The electrician upgraded the panel and replaced the breaker");
    const findings = rules([...filler, gold], [
      query({ id: "leaky", category: "paraphrase", text: "electrician panel breaker cost" }),
      query({ id: "clean", category: "paraphrase", text: "who fixed the wiring at home" }),
    ]);
    expect(findings).toContain("leaky:paraphrase-lexical-leak");
    expect(findings).not.toContain("clean:paraphrase-lexical-leak");
  });

  it("rejects one rare shared word in a paraphrase", () => {
    expect(rules([entry("g", "Quokka sighting on the harbor walk")], [
      query({ id: "quokka", category: "paraphrase", text: "quokka origin story" }),
    ])).toContain("quokka:paraphrase-lexical-leak");
  });

  it("rejects a paraphrase whose term occurs inside a gold word", () => {
    expect(rules([entry("g", "The electrician upgraded the panel")], [
      query({ id: "electric", category: "paraphrase", text: "electric fix cost" }),
    ])).toContain("electric:paraphrase-lexical-leak");
  });

  it("counts substrings when deciding whether a rare word floods the corpus", () => {
    const copies = Array.from({ length: 30 }, (_, i) => entry(`copy-${i}`, `Start the party smart cart ${i}`));
    expect(rules([entry("g", "art gallery visit"), ...copies], [
      query({ id: "art", category: "rare-word", text: "art" }),
    ])).toContain("art:rare-word-no-rare-token");
  });

  it("counts identifier prefixes in other rows for flooding, but requires a bounded identifier in gold", () => {
    const copies = Array.from({ length: 30 }, (_, i) => entry(`copy-${i}`, `Invoice INV-88213-${i} archived`));
    expect(rules([entry("g", "Invoice INV-88213 settled"), ...copies], [
      query({ id: "invoice", category: "identifier", text: "INV-88213" }),
    ])).toContain("invoice:identifier-too-common");
    expect(rules([entry("g", "Invoice INV-88213X settled")], [
      query({ id: "partial", category: "identifier", text: "INV-88213" }),
    ])).toContain("partial:identifier-not-in-gold");
  });

  it("matches Korean short words and detects Korean paraphrase leakage within a longer form", () => {
    const gold = entry("g", "민수와 예산에 대해 이야기했다");
    expect(rules([gold], [query({ id: "short-ko", category: "short-word", text: "민수" })])).toEqual([]);
    expect(rules([gold], [query({ id: "para-ko", category: "paraphrase", text: "민수 새 계획" })])).toContain("para-ko:paraphrase-lexical-leak");
  });

  it("checks rare, common, and short word category definitions", () => {
    const gold = entry("g", "budget review planning session zylophantine project v2");
    // budget and planning never co-occur outside the gold, so the trio is unique to it
    const split = Array.from({ length: 40 }, (_, i) => entry(`s${i}`, i % 2 ? `weekly review notes about budget ${i}` : `planning notes about review ${i}`));
    expect(rules([...filler, gold], [query({ id: "rare", category: "rare-word", text: "zylophantine" })])).toEqual([]);
    expect(rules([...filler, gold], [query({ id: "no-rare", category: "rare-word", text: "budget review" })])).toContain("no-rare:rare-word-no-rare-token");
    expect(rules([...split, gold], [query({ id: "common", category: "common-word", text: "budget review planning" })])).toEqual([]);
    expect(rules([...filler, gold], [query({ id: "mixed", category: "common-word", text: "budget zylophantine" })])).toContain("mixed:common-word-rare-token");
    expect(rules([...filler, gold], [query({ id: "missing", category: "common-word", text: "budget review notes" })])).toContain("missing:common-word-gold-missing-token");
    expect(rules([...filler, gold], [query({ id: "short", category: "short-word", text: "v2" })])).toEqual([]);
    expect(rules([...filler, gold], [query({ id: "long", category: "short-word", text: "project" })])).toContain("long:short-word-no-short-token");
  });

  it("rejects a common-word query that another readable entry also fully matches", () => {
    const gold = entry("g", "budget review planning session");
    const split = Array.from({ length: 40 }, (_, i) => entry(`s${i}`, i % 2 ? `weekly review notes about budget ${i}` : `planning notes about review ${i}`));
    const text = "budget review planning";
    const ask = (entries: CorpusEntry[], viewer: GoldenQuery["viewer"] = "avery") => rules(entries, [query({ id: "amb", category: "common-word", text, viewer })]);
    expect(ask([...split, gold])).toEqual([]);
    expect(ask([...split, gold, entry("rival", "Notes on the planning review and budget")])).toContain("amb:common-word-ambiguous");
    expect(ask([...split, gold, entry("rival", "BUDGETS, reviews and planning")])).toContain("amb:common-word-ambiguous");
    // an unreadable rival does not make the query ambiguous
    expect(ask([...split, gold, entry("hidden", "budget review planning", "blake")])).toEqual([]);
  });

  it("rejects missing, unreadable, or duplicated gold queries and missing tenancy decoys", () => {
    const gold = entry("g", "Ticket OPS-90210 rollback plan");
    const decoy = entry("d", "Ticket OPS-90210 rollback plan", "blake");
    const tenancy = query({ id: "tenant", category: "identifier", text: "OPS-90210", tags: ["tenancy"] });
    expect(rules([...filler, gold, decoy], [tenancy])).toEqual([]);
    expect(rules([...filler, gold], [tenancy])).toContain("tenant:tenancy-no-decoy");
    expect(rules([entry("g", "private thing xylo", "blake")], [query({ id: "leak", category: "rare-word", text: "xylo" })])).toContain("leak:gold-unreadable");
    expect(rules([], [query({ id: "gone", category: "rare-word", text: "xylo" })])).toContain("gone:gold-missing");
    expect(rules([gold], [tenancy, tenancy])).toContain("tenant:duplicate-id");
  });

  it("checks CJK text, multi-hop reachability, and long-context answer position", () => {
    const root = entry("root", "Meridian vendor decision was finalized after review");
    const gold = entry("g", "Because the audit found a gap, procurement chose a different supplier");
    const edge: CorpusEdge = { id: "e", sourceId: "root", targetId: "g", type: "caused_by", weight: 0.9, provenance: "explicit", workspaceId: WORKSPACES.avery };
    const multi = query({ id: "multi", category: "multi-hop", text: "Meridian vendor decision reason", hops: 1 });
    expect(rules([...filler, root, gold], [multi], [edge])).toEqual([]);
    expect(rules([...filler, root, gold], [multi])).toContain("multi:multi-hop-unreachable");
    expect(rules([...filler, root, gold], [{ ...multi, text: "Meridian vendor decision procurement supplier" }], [edge])).toContain("multi:multi-hop-lexical-leak");
    expect(rules([...filler, root, gold], [{ ...multi, hops: 2 }], [edge])).toContain("multi:multi-hop-needs-hops");
    expect(rules([...filler, entry("root", root.content, "blake"), gold], [multi], [edge])).toContain("multi:multi-hop-unreachable");
    expect(rules([...filler, gold], [query({ id: "cjk", category: "cjk", text: "来月の予算" })])).toContain("cjk:cjk-gold-not-cjk");
    expect(rules([entry("g", "来月の予算について話した")], [query({ id: "cjk-valid", category: "cjk", text: "来月の予算" })])).toEqual([]);
    expect(rules([entry("g", "来月の予算について話した")], [query({ id: "cjk-unlinked", category: "cjk", text: "採用計画" })])).toContain("cjk-unlinked:cjk-no-shared-substring");
    expect(rules([entry("g", "来月の予算について話した")], [query({ id: "cjk-one", category: "cjk", text: "budget 夢" })])).toContain("cjk-one:cjk-no-shared-substring");
    expect(rules([entry("g", "来月の予算について話した")], [query({ id: "xl", category: "cjk", text: "next month budget", tags: ["cross-lingual"] })])).toEqual([]);
    expect(rules([entry("g", "𠮷野家で食べた")], [query({ id: "cjk-ext", category: "cjk", text: "𠮷野家" })])).toEqual([]);
    expect(rules([entry("g", "﨑山で食べた")], [query({ id: "cjk-compat", category: "cjk", text: "﨑山" })])).toEqual([]);
    const long = entry("g", `${"Filler passage. ".repeat(120)}The answer is cobalt.`);
    expect(rules([long], [query({ id: "long", category: "long-context", text: "which color", answerSpan: "cobalt" })])).toEqual([]);
    expect(rules([entry("g", "The answer is cobalt.")], [query({ id: "short", category: "long-context", text: "which color", answerSpan: "cobalt" })])).toContain("short:long-context-single-chunk");
    expect(rules([entry("g", `The answer is cobalt. ${"Filler passage. ".repeat(120)}`)], [query({ id: "early", category: "long-context", text: "which color", answerSpan: "cobalt" })])).toContain("early:long-context-answer-in-first-chunk");
  });

  it("exposes deterministic haystack vocabulary for needle-key checks", () => {
    const vocabulary = haystackVocabulary();
    expect(vocabulary.has("roadmap")).toBe(true);
    expect(vocabulary.has("zylophantine")).toBe(false);
    for (const prefix of ["ops", "web", "app"]) {
      for (let number = 1000; number < 8000; number++) expect(vocabulary.has(`${prefix}-${number}`)).toBe(true);
    }
  }, 30_000);
});

describe("auditQueries fidelity and scale", () => {
  const gold = (content: string, workspace: keyof typeof WORKSPACES = "avery") => entry("g", content, workspace);
  const many = (count: number, content: (i: number) => string, workspace: keyof typeof WORKSPACES = "avery") =>
    Array.from({ length: count }, (_, i) => entry(`m${workspace}${i}`, content(i), workspace));

  it("does not let cross-lingual excuse CJK text or a shared Latin word", () => {
    const ja = gold("来月の予算について話した budget");
    expect(rules([ja], [query({ id: "cjk-in-xl", category: "cjk", text: "採用計画の見直し", tags: ["cross-lingual"] })])).toContain("cjk-in-xl:cross-lingual-has-cjk");
    expect(rules([ja], [query({ id: "leak", category: "cjk", text: "budget review", tags: ["cross-lingual"] })])).toContain("leak:cross-lingual-lexical-leak");
    expect(rules([ja], [query({ id: "ok", category: "cjk", text: "next month plan", tags: ["cross-lingual"] })])).toEqual([]);
  });

  it("checks CJK linkage on the tokens the arm searches, not on raw character pairs", () => {
    const ja = gold("来月の予算について話した");
    expect(rules([ja], [query({ id: "pair", category: "cjk", text: "月の予定" })])).toContain("pair:cjk-no-shared-substring");
    expect(rules([ja], [query({ id: "whole", category: "cjk", text: "来月の予算" })])).toEqual([]);
  });

  it("counts df over the rows the viewer can read", () => {
    const rows = [gold("zorbital flimwatt"), ...many(40, () => "zorbital flimwatt", "blake")];
    expect(rules(rows, [query({ id: "c", category: "common-word", text: "zorbital flimwatt" })])).toContain("c:common-word-rare-token");
    const decoys = many(6, () => "Ticket OPS-90210 rollback", "outsider");
    expect(rules([gold("Ticket OPS-90210 rollback"), ...decoys], [query({ id: "i", category: "identifier", text: "OPS-90210" })])).toEqual([]);
  });

  it("scales the paraphrase and common thresholds with the corpus", () => {
    const corpus = (total: number, dense: number) => [
      gold("zonkfrel appears in the answer"),
      ...many(dense - 1, i => `zonkfrel filler note ${i}`),
      ...many(total - dense, i => `plain unrelated note ${i}`),
    ];
    const para = query({ id: "p", category: "paraphrase", text: "zonkfrel origin story" });
    expect(rules(corpus(1000, 25), [para])).toEqual([]);
    expect(rules(corpus(5000, 30), [para])).toContain("p:paraphrase-lexical-leak");
    expect(rules(corpus(20_000, 300), [para])).toContain("p:paraphrase-lexical-leak");
    expect(rules(corpus(20_000, 500), [para])).toEqual([]);
    const common = query({ id: "c", category: "common-word", text: "zonkfrel appears" });
    expect(rules(corpus(5000, 30), [common])).toContain("c:common-word-rare-token");
  });

  it("declares the outsider decoys-only and fails closed on unknown tags", () => {
    const decoyGold = gold("secret OPS-90210 plan", "outsider");
    const own = query({ id: "o", category: "identifier", text: "OPS-90210", viewer: "outsider" });
    expect(rules([decoyGold], [own])).toContain("o:outsider-not-tenancy");
    expect(rules([decoyGold, entry("d", "secret OPS-90210 plan")], [{ ...own, tags: ["tenancy"] }])).toEqual([]);
    expect(rules([gold("hello world")], [query({ id: "t", category: "paraphrase", text: "greeting", tags: ["tenency"] })])).toContain("t:unknown-tag");
  });

  it("requires a key token for tenancy queries instead of guessing one", () => {
    expect(rules([gold("hello world")], [query({ id: "t", category: "paraphrase", text: "greeting", tags: ["tenancy"] })])).toContain("t:tenancy-no-key-token");
  });

  it("keeps trailing punctuation the way production tokenizes it", () => {
    const g = gold("roadmap review scheduled");
    expect(rules([...filler, g], [query({ id: "dots", category: "common-word", text: "roadmap. review." })])).toContain("dots:common-word-gold-missing-token");
  });

  it("keeps common-word queries on the default read scope of a non-outsider viewer", () => {
    const g = gold("weekly review budget notes");
    const q = query({ id: "c", category: "common-word", text: "weekly review budget" });
    // weekly and budget never co-occur outside the gold, so the trio is unique to it
    const split = Array.from({ length: 40 }, (_, i) => entry(`s${i}`, i % 2 ? `weekly review notes ${i}` : `budget review notes ${i}`));
    expect(rules([...split, g], [q])).toEqual([]);
    expect(rules([...split, g], [{ ...q, layer: "company" }])).toContain("c:common-word-layer-scoped");
    expect(rules([...split, g], [{ ...q, viewer: "outsider" }])).toContain("c:common-word-layer-scoped");
  });

  it("waives only identifier-not-in-gold for a known-gap underscore query, and demands a gap reference", () => {
    const gold = entry("g", "Uploads failed with ERR_QUOTA_77120 after the bucket filled up");
    const q = (over: Partial<GoldenQuery> = {}) => query({ id: "u", category: "identifier", text: "ERR_QUOTA_77120", ...over });
    const gap = ["known-gap", "gap:T-0072"];
    expect(rules([...filler, gold], [q()])).toContain("u:identifier-not-in-gold");
    expect(rules([...filler, gold], [q({ tags: gap })])).toEqual([]);
    expect(rules([...filler, gold], [q({ tags: ["known-gap", "gap:T-15"] })])).toEqual([]);
    // still applies: a key the gold lacks, an unreadable gold, a digitless key
    expect(rules([...filler, gold], [q({ text: "ERR_QUOTA_99999", tags: gap })])).toContain("u:identifier-not-in-gold");
    expect(rules([...filler, entry("g", gold.content, "blake")], [q({ tags: gap })])).toContain("u:gold-unreadable");
    expect(rules([...filler, gold], [q({ text: "err_quota", tags: gap })])).toContain("u:identifier-no-token");
    // no underscore, so stripping is not the cause: the waiver does not apply
    expect(rules([...filler, gold], [q({ text: "ERR-QUOTA-99999", tags: gap })])).toContain("u:identifier-not-in-gold");
    const flood = Array.from({ length: 6 }, (_, i) => entry(`x${i}`, `copy ERRQUOTA77120 ${i}`));
    expect(rules([...filler, entry("g", "ERRQUOTA77120 seen"), ...flood], [q({ text: "ERRQUOTA77120", tags: gap })])).toContain("u:identifier-too-common");
    // gap tags must be well-formed and paired
    expect(rules([...filler, gold], [q({ tags: ["known-gap"] })])).toContain("u:known-gap-no-ref");
    expect(rules([...filler, gold], [q({ tags: ["known-gap", "gap:T-0072", "gap:oops"] })])).toContain("u:unknown-tag");
    expect(rules([...filler, gold], [q({ tags: ["gap:T-0072"] })])).toContain("u:gap-ref-without-known-gap");
    expect(rules([...filler, gold], [q({ tags: ["gap"] })])).toContain("u:unknown-tag");
  });
});
