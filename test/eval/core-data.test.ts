import { historyProblems, type Manifest } from "./lock";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FTS_MATCH_BUDGET, KEYWORD_CANDIDATE_LIMIT } from "../../src/constants";
import { readScopeWorkspaces } from "../../src/lib/scope";
import { longContextNeedles, mechanicalQueries } from "./corpus/author";
import { auditQueries, haystackVocabulary, keywordRouteModel, staleRouteGaps } from "./corpus/audit";
import { CORPUS_PARAMS, buildCorpus, loadCoreData } from "./corpus/build";
import { COMMON_TOKENS, DENSE_RATE_BY_SCALE, DENSE_TOKENS } from "./corpus/haystack";
import { IDENTITIES, WORKSPACES } from "./corpus/types";
import { QUERY_CATEGORIES } from "./types";

const DATA = resolve(import.meta.dirname, "data/core");
const MINIMUMS = { identifier: 36, "rare-word": 40, "common-word": 36, "short-word": 30, paraphrase: 48, cjk: 36, "multi-hop": 30, "long-context": 24 } as const;
const CLUSTER_MINIMUM = 30;
// 0.8 x the shipped per-category cluster counts, so a ~35% power cut in any category fails
const CLUSTER_FLOORS = { identifier: 37, "rare-word": 31, "common-word": 38, "short-word": 24, paraphrase: 39, cjk: 29, "multi-hop": 24, "long-context": 20 } as const;

describe("core golden data", () => {
  const { needles, edges, queries } = loadCoreData();

  it("matches the manifest hashes, so any edit is deliberate (record it with lock --accept-data-change)", () => {
    const manifest = JSON.parse(readFileSync(resolve(DATA, "manifest.json"), "utf8")) as Manifest;
    const onDisk = readdirSync(DATA).filter(name => name.endsWith(".jsonl")).sort();
    expect(Object.keys(manifest.files).sort()).toEqual(onDisk);
    for (const [name, hash] of Object.entries(manifest.files)) {
      expect(createHash("sha256").update(readFileSync(resolve(DATA, name))).digest("hex"), name).toBe(hash);
    }
    // A hash rewritten without a matching history entry is as bad as an unrecorded data edit.
    expect(historyProblems(manifest)).toEqual([]);
  });

  it("records counts in the manifest that match the loaded data", () => {
    const { counts } = JSON.parse(readFileSync(resolve(DATA, "manifest.json"), "utf8")) as { counts: Record<string, unknown> };
    const spec = buildCorpus("core-1k");
    const tally = (rows: { purpose?: string; category?: string }[], key: "purpose" | "category") => {
      const out: Record<string, number> = {};
      for (const category of QUERY_CATEGORIES) out[category] = rows.filter(row => row[key] === category).length;
      return out;
    };
    const clusters: Record<string, number> = {};
    for (const category of QUERY_CATEGORIES) clusters[category] = new Set(spec.queries.filter(q => q.category === category).map(q => q.clusterKey)).size;
    expect(counts).toEqual({
      needles: needles.length,
      queries: queries.length,
      needlesByPurpose: tally(needles, "purpose"),
      byCategory: tally(queries, "category"),
      clustersByCategory: clusters,
    });
  });

  it("meets the per-category query minimums and covers every category", () => {
    for (const category of QUERY_CATEGORIES) {
      expect(queries.filter(q => q.category === category).length, category).toBeGreaterThanOrEqual(MINIMUMS[category]);
    }
    expect(queries.length).toBeGreaterThanOrEqual(280);
    expect(queries.filter(q => q.tags?.includes("tenancy")).length).toBeGreaterThanOrEqual(14);
  });

  it("has enough distinct clusters overall and per category for the bootstrap", () => {
    const spec = buildCorpus("core-1k");
    expect(new Set(spec.queries.map(q => q.clusterKey)).size).toBeGreaterThanOrEqual(CLUSTER_MINIMUM);
    for (const category of QUERY_CATEGORIES) {
      const clusters = new Set(spec.queries.filter(q => q.category === category).map(q => q.clusterKey));
      expect(clusters.size, category).toBeGreaterThanOrEqual(CLUSTER_FLOORS[category]);
    }
  });

  it("has unique needle ids, valid edges, and fictional-only content", () => {
    expect(new Set(needles.map(n => n.id)).size).toBe(needles.length);
    const ids = new Set(needles.map(n => n.id));
    for (const e of edges) { expect(ids.has(e.source), e.source).toBe(true); expect(ids.has(e.target), e.target).toBe(true); }
    const pairs = edges.map(e => `${e.source}|${e.target}|${e.type}`);
    expect(pairs.filter((pair, i) => pairs.indexOf(pair) !== i), "duplicate edges").toEqual([]);
    for (const n of needles) expect(n.content.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)?.every(m => m.endsWith("@example.com")) ?? true, n.id).toBe(true);
  });

  it("regenerates the long-context needles byte-identically and keeps them varied", () => {
    const generated = longContextNeedles();
    expect(needles.filter(n => n.purpose === "long-context")).toEqual(generated);
    const sentences = generated.map(n => new Set(n.content.match(/[^.]+\./g)!.map(sentence => sentence.trim())));
    for (let i = 0; i < sentences.length; i++) {
      for (let j = i + 1; j < sentences.length; j++) {
        const shared = [...sentences[i]].filter(sentence => sentences[j].has(sentence)).length;
        expect(shared, `${generated[i].id} vs ${generated[j].id}`).toBeLessThanOrEqual(3);
      }
    }
    for (const q of queries.filter(q => q.category === "long-context")) {
      expect(generated.filter(n => n.content.includes(q.answerSpan!)).length, q.id).toBe(1);
    }
  });

  it("keeps the mechanical identifier and rare-word queries identical to their generator output", () => {
    const generated = mechanicalQueries(needles);
    expect(queries.slice(0, generated.length)).toEqual(generated);
  });

  it("has retired gap:T-0072: underscore identifiers are ordinary queries, and only boarded route gaps remain", () => {
    expect(queries.filter(q => q.tags?.includes("gap:T-0072")).map(q => q.id)).toEqual([]);
    // the twelve underscore queries are still present, untagged, and count toward the identifier headline
    const underscore = queries.filter(q => q.category === "identifier" && q.text.includes("_"));
    expect(underscore.length).toBe(12);
    for (const q of underscore) expect(q.tags?.includes("known-gap") ?? false, q.id).toBe(false);
    // every remaining known-gap query names at least one boarded gap, and only the boarded ones
    for (const q of queries.filter(q => q.tags?.includes("known-gap"))) {
      const refs = q.tags!.filter(tag => tag.startsWith("gap:"));
      expect(refs.length, q.id).toBeGreaterThanOrEqual(1);
      for (const ref of refs) expect(["gap:T-0073", "gap:T-0074"], q.id).toContain(ref);
    }
  });

  it("puts the tenancy decoys of the blake company-layer identifier queries in another tenant", () => {
    const outsider = new Set(needles.filter(n => n.workspace === "outsider").map(n => n.id));
    for (const id of ["001", "021", "031"]) expect(outsider.has(`n-id-${id}-decoy`), id).toBe(true);
  });

  it("gives each common-word query its own triple of dense words, found in its gold needle and no other", () => {
    const isDense = (word: string) => (DENSE_TOKENS as readonly string[]).includes(word);
    const dense = (text: string) => DENSE_TOKENS.filter(word => text.toLowerCase().includes(word));
    const common = queries.filter(q => q.category === "common-word");
    const triples = new Set<string>();
    for (const q of common) {
      const words = q.text.split(" ");
      const triple = words.filter(isDense).sort();
      expect(triple.length, q.id).toBe(3);
      // only T-0073 queries carry extra tokens, and those are the ordinary common ones
      const extra = words.filter(word => !isDense(word));
      if (q.tags?.includes("gap:T-0073")) {
        expect(extra.length, q.id).toBeGreaterThanOrEqual(1);
        expect(extra.every(word => (COMMON_TOKENS as readonly string[]).includes(word)), q.id).toBe(true);
      } else expect(extra, q.id).toEqual([]);
      triples.add(triple.join(","));
      const gold = needles.find(n => n.id === q.gold[0].id)!;
      expect(dense(gold.content).sort(), q.id).toEqual(triple);
      expect(gold.ageDays, `${q.id} gold must be old enough to fall outside the LIKE window`).toBeGreaterThanOrEqual(300);
    }
    expect(triples.size, "distinct triples").toBe(common.length);
    const goldIds = new Set(common.map(q => q.gold[0].id));
    // as substrings, so "timetable" or "newsletter" count
    for (const n of needles.filter(n => !goldIds.has(n.id))) expect(dense(n.content).length, n.id).toBeLessThanOrEqual(2);
  });

  // T-0073 and T-0074 are scale-dependent: the LIKE window (newest 500 matches) holds every match at core-1k, so
  // these queries are still answerable there. They lose the gold only at scale-5k and scale-20k, which is where a
  // router fix is evaluated.
  it("pins the T-0073 queries (router sends keyword search to LIKE past FTS_MATCH_BUDGET)", () => {
    const gaps = queries.filter(q => q.tags?.includes("gap:T-0073"));
    expect(gaps.map(q => q.id)).toEqual(["q-id-023-c", "q-id-030-c", ...Array.from({ length: 10 }, (_, i) => `q-budget-${String(i + 1).padStart(3, "0")}`)]);
    for (const q of gaps) expect(q.tags, q.id).toContain("known-gap");
    const budget = gaps.filter(q => q.id.startsWith("q-budget-"));
    expect(new Set(budget.map(q => q.gold[0].id)).size, "one cluster per deliberate needle").toBe(10);
    // the deliberate tier crosses the budget at both scales; the identifier ones only at 20k, where the "roadmap" prefix and the key's variants are dense enough
    for (const id of ["scale-5k", "scale-20k"] as const) {
      const spec = buildCorpus(id);
      for (const q of id === "scale-5k" ? budget : gaps) {
        const readable = new Set(readScopeWorkspaces(IDENTITIES[q.viewer], { layer: q.layer }));
        const visible = spec.entries.filter(e => readable.has(e.workspaceId)).map(entry => ({ entry, content: entry.content.toLowerCase() }));
        // the real retrieval tokens, variants included ("MSA-2026-88031" also counts "2026")
        const model = keywordRouteModel(q.text, visible, spec.entries.find(e => e.id === q.gold[0].id)!.createdAt);
        expect(model.dfSum, `${id} ${q.id} ${q.text}`).toBeGreaterThan(FTS_MATCH_BUDGET);
        expect(model.route, `${id} ${q.id}`).toBe("like-match-budget");
      }
    }
  });

  it("pins the T-0074 queries (one FTS-ineligible token forces the whole query to LIKE)", () => {
    const gaps = queries.filter(q => q.tags?.includes("gap:T-0074"));
    expect(gaps.map(q => q.id)).toEqual(["q-id-007", "q-id-007-c", "q-id-024", "q-id-024-c", "q-id-035", "q-id-035-c", "q-short-027", "q-short-030"]);
    for (const q of gaps) expect(q.tags, q.id).toContain("known-gap");
    const spec = buildCorpus("scale-20k");
    for (const q of gaps) {
      const readable = new Set(readScopeWorkspaces(IDENTITIES[q.viewer], { layer: q.layer }));
      const visible = spec.entries.filter(e => readable.has(e.workspaceId)).map(entry => ({ entry, content: entry.content.toLowerCase() }));
      const gold = spec.entries.find(e => e.id === q.gold[0].id)!;
      expect(keywordRouteModel(q.text, visible, gold.createdAt).route, q.id).toBe("like-ineligible-token");
    }
  });

  it("keeps every T-0073 and T-0074 query answerable at core-1k under the route model, and lost at scale", () => {
    const gaps = queries.filter(q => q.tags?.some(tag => tag === "gap:T-0073" || tag === "gap:T-0074"));
    expect(gaps.length).toBe(20);
    const modelAt = (id: "core-1k" | "scale-5k" | "scale-20k", q: (typeof gaps)[number]) => {
      const spec = buildCorpus(id);
      const readable = new Set(readScopeWorkspaces(IDENTITIES[q.viewer], { layer: q.layer }));
      const visible = spec.entries.filter(e => readable.has(e.workspaceId)).map(entry => ({ entry, content: entry.content.toLowerCase() }));
      return keywordRouteModel(q.text, visible, spec.entries.find(e => e.id === q.gold[0].id)!.createdAt);
    };
    for (const q of gaps) {
      const tie = modelAt("core-1k", q);
      // LIKE may be the route, but its window still holds the gold: the gap does not show at the tie scale
      expect(tie.lost, `${q.id} at core-1k: ${tie.route}, ${tie.newer} newer`).toBe(false);
      expect(tie.newer, q.id).toBeLessThan(KEYWORD_CANDIDATE_LIMIT);
    }
    // and each is really lost at some discriminating scale, on the route it names
    const stale = staleRouteGaps(["scale-5k", "scale-20k"].map(id => buildCorpus(id as "scale-5k")));
    expect(stale).toEqual([]);
  });

  it("keeps every rare and identifier key out of the haystack vocabulary", () => {
    const vocab = haystackVocabulary();
    for (const n of needles.filter(n => n.purpose === "rare-word" || n.purpose === "identifier")) {
      for (const key of n.keys ?? []) expect(vocab.has(key.toLowerCase()), key).toBe(false);
    }
  });

  it("passes the query audit on the whole core set, on every corpus size", () => {
    const specs = (["core-1k", "scale-5k", "scale-20k"] as const).map(id => buildCorpus(id));
    for (const spec of specs) {
      const findings = auditQueries({ entries: spec.entries, edges: spec.edges, queries: spec.queries, intent: spec.intent });
      expect(findings, `${spec.id}: ${JSON.stringify(findings.slice(0, 10), null, 1)}`).toEqual([]);
    }
    // a route gap tag must be earned at some discriminating scale
    expect(staleRouteGaps(specs)).toEqual([]);
  }, 60_000);

  it("builds three corpora of the requested sizes with the needles unchanged", () => {
    const sizes = { "core-1k": 1000, "scale-5k": 5000, "scale-20k": 20000 } as const;
    for (const [id, total] of Object.entries(sizes)) {
      const spec = buildCorpus(id as keyof typeof sizes);
      expect(spec.entries).toHaveLength(total);
      expect(new Set(spec.entries.map(e => e.id)).size).toBe(total);
      expect(spec.queries).toEqual(buildCorpus("core-1k").queries);
    }
  });

  it("uses the tuned haystack rates: the pinned dense rates and a 0.08 common rate at 20k", () => {
    expect(CORPUS_PARAMS["core-1k"].denseRate).toBe(DENSE_RATE_BY_SCALE["1k"]);
    expect(CORPUS_PARAMS["scale-5k"].denseRate).toBe(DENSE_RATE_BY_SCALE["5k"]);
    expect(CORPUS_PARAMS["scale-20k"].denseRate).toBe(DENSE_RATE_BY_SCALE["20k"]);
    expect(CORPUS_PARAMS["scale-20k"].commonRate).toBe(0.08);
    // the haystack is the total minus the needles, which is what the rates were solved for
    const haystack = buildCorpus("scale-5k").entries.filter(e => e.id.startsWith("f-")).length;
    expect(haystack).toBe(5000 - needles.length);
  });

  it("draws the haystack at 45/45/10 across avery, company and blake, with nothing in the outsider tenant", () => {
    const spec = buildCorpus("scale-5k");
    const haystack = spec.entries.filter(e => e.id.startsWith("f-"));
    const share = (workspaceId: string) => haystack.filter(e => e.workspaceId === workspaceId).length / haystack.length;
    expect(share(WORKSPACES.avery)).toBeCloseTo(0.45, 1);
    expect(share(WORKSPACES.company)).toBeCloseTo(0.45, 1);
    expect(share(WORKSPACES.blake)).toBeCloseTo(0.1, 1);
    expect(share(WORKSPACES.outsider)).toBe(0);
  });

  it("truncates the LIKE window only where intended: common token over 500 matches at 5k and 20k, under 500 at 1k", () => {
    const matches = (id: "core-1k" | "scale-5k" | "scale-20k") => buildCorpus(id).entries.filter(e => e.content.toLowerCase().includes(COMMON_TOKENS[0])).length;
    expect(matches("core-1k")).toBeLessThan(KEYWORD_CANDIDATE_LIMIT);
    expect(matches("scale-5k")).toBeGreaterThan(KEYWORD_CANDIDATE_LIMIT);
    expect(matches("scale-20k")).toBeGreaterThan(KEYWORD_CANDIDATE_LIMIT * 3);
  });

  it("puts at least 500 newer, viewer-visible common-token matches in front of every old rare-word target at 5k and 20k (the LIKE trap)", () => {
    for (const id of ["scale-5k", "scale-20k"] as const) {
      const spec = buildCorpus(id);
      const byId = new Map(spec.entries.map(e => [e.id, e] as const));
      const trapped = spec.queries.filter(q => q.category === "rare-word" && q.id.endsWith("-c"));
      expect(trapped.length, id).toBeGreaterThanOrEqual(15);
      for (const q of trapped) {
        const gold = byId.get(q.gold[0].id)!;
        const visible = new Set(readScopeWorkspaces(IDENTITIES[q.viewer], { layer: q.layer }));
        const common = COMMON_TOKENS.find(t => q.text.toLowerCase().startsWith(t))!;
        const newer = spec.entries.filter(e => e.createdAt > gold.createdAt && visible.has(e.workspaceId) && e.content.toLowerCase().includes(common)).length;
        expect(newer, `${id} ${q.id}`).toBeGreaterThanOrEqual(KEYWORD_CANDIDATE_LIMIT);
      }
    }
  });
});
