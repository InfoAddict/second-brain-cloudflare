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

  it("checks rare, common, and short word category definitions", () => {
    const gold = entry("g", "budget review planning session zylophantine project v2");
    expect(rules([...filler, gold], [query({ id: "rare", category: "rare-word", text: "zylophantine" })])).toEqual([]);
    expect(rules([...filler, gold], [query({ id: "no-rare", category: "rare-word", text: "budget review" })])).toContain("no-rare:rare-word-no-rare-token");
    expect(rules([...filler, gold], [query({ id: "common", category: "common-word", text: "budget review planning" })])).toEqual([]);
    expect(rules([...filler, gold], [query({ id: "mixed", category: "common-word", text: "budget zylophantine" })])).toContain("mixed:common-word-rare-token");
    expect(rules([...filler, gold], [query({ id: "missing", category: "common-word", text: "budget review notes" })])).toContain("missing:common-word-gold-missing-token");
    expect(rules([...filler, gold], [query({ id: "short", category: "short-word", text: "v2" })])).toEqual([]);
    expect(rules([...filler, gold], [query({ id: "long", category: "short-word", text: "project" })])).toContain("long:short-word-no-short-token");
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
    expect(rules([...filler, gold], [query({ id: "cjk", category: "cjk", text: "来月の予算" })])).toContain("cjk:cjk-gold-not-cjk");
    expect(rules([entry("g", "来月の予算について話した")], [query({ id: "cjk-valid", category: "cjk", text: "来月の予算" })])).toEqual([]);
    const long = entry("g", `${"Filler passage. ".repeat(120)}The answer is cobalt.`);
    expect(rules([long], [query({ id: "long", category: "long-context", text: "which color", answerSpan: "cobalt" })])).toEqual([]);
    expect(rules([entry("g", "The answer is cobalt.")], [query({ id: "short", category: "long-context", text: "which color", answerSpan: "cobalt" })])).toContain("short:long-context-single-chunk");
  });

  it("exposes deterministic haystack vocabulary for needle-key checks", () => {
    const vocabulary = haystackVocabulary();
    expect(vocabulary.has("roadmap")).toBe(true);
    expect(vocabulary.has("zylophantine")).toBe(false);
  });
});
