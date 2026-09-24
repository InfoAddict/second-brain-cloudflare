import { historyProblems, type Manifest } from "./lock";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import { FTS_MATCH_BUDGET, FTS_MIN_TOKEN_LENGTH, KEYWORD_CANDIDATE_LIMIT } from "../../src/constants";
import { readScopeWorkspaces } from "../../src/lib/scope";
import { longContextNeedles, mechanicalQueries } from "./corpus/author";
import { auditQueries, haystackVocabulary, keywordRouteModel, staleRouteGaps } from "./corpus/audit";
import { CORPUS_IDS, CORPUS_PARAMS, HAYSTACK_ROWS, buildCorpus as buildCorpusUncached, loadCoreData } from "./corpus/build";
import { COMMON_TOKENS, CORRELATED_TOKENS, DENSE_RATE_BY_SCALE, DENSE_TOKENS } from "./corpus/haystack";
import { IDENTITIES, WORKSPACES } from "./corpus/types";
import { QUERY_CATEGORIES } from "./types";

// Each corpus is built once for the whole file: the tests only read it, and building one per test (about 25
// builds, the 20k one the largest) is what pushed single tests past the 5 s default under load.
const built = new Map<string, ReturnType<typeof buildCorpusUncached>>();
const buildCorpus: typeof buildCorpusUncached = id => {
  if (!built.has(id)) built.set(id, buildCorpusUncached(id));
  return built.get(id)!;
};

const DATA = resolve(import.meta.dirname, "data/core");
// T-0043.6 grew the set from 338 queries / 299 clusters to 1,586 queries / 1,433 clusters (4.8x), weighted to the target
// categories: paraphrase 9x (48 -> 440), multi-hop 5x (30 -> 150), long-context 9x (24 -> 220). Gate power scales with
// independent clusters, and a target category needs about +0.05 with a lower bound above zero, so paraphrase (the reranker)
// and long-context (contextual embeddings) got the most. Minimums and floors are 0.8 x the shipped counts, so a ~35% power
// cut in any category fails. Common-word clusters are dense triples (84 for 133 queries: the same triple in the two
// viewer scopes is one cluster), which is why its floor is lower than its query minimum.
const MINIMUMS = { identifier: 120, "rare-word": 105, "common-word": 105, "short-word": 80, paraphrase: 352, cjk: 88, "multi-hop": 120, "long-context": 176 } as const;
const CLUSTER_MINIMUM = 1140;
const CLUSTER_FLOORS = { identifier: 120, "rare-word": 104, "common-word": 67, "short-word": 80, paraphrase: 352, cjk: 88, "multi-hop": 120, "long-context": 176 } as const;

describe("core golden data", () => {
  beforeAll(() => { for (const id of ["core-1k", "scale-5k", "scale-20k"] as const) buildCorpus(id); }, 60_000);

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
    expect(queries.length).toBeGreaterThanOrEqual(1268);
    expect(queries.filter(q => q.tags?.includes("tenancy")).length).toBeGreaterThanOrEqual(60);
  });

  it("authors an importance score (1-5) on every needle and seeds one on every haystack row, skewed to 2-3", () => {
    const spec = buildCorpus("core-1k");
    const needleRows = spec.entries.filter(e => e.id.startsWith("n-"));
    const haystack = spec.entries.filter(e => e.id.startsWith("f-"));
    expect(needleRows).toHaveLength(needles.length);
    for (const entry of spec.entries) expect(Number.isInteger(entry.importanceScore) && entry.importanceScore! >= 1 && entry.importanceScore! <= 5, entry.id).toBe(true);
    const shares = (rows: typeof spec.entries) => [1, 2, 3, 4, 5].map(score => rows.filter(e => e.importanceScore === score).length / rows.length);
    for (const rows of [needleRows, haystack]) {
      const [one, two, three, four, five] = shares(rows);
      expect(two + three, "scores 2-3 dominate").toBeGreaterThan(0.5);
      expect(five, "5s are rare").toBeLessThan(0.08);
      expect(one + five, "extremes are the tails").toBeLessThan(two);
      expect(four).toBeGreaterThan(0.05);
      const mean = rows.reduce((sum, e) => sum + e.importanceScore!, 0) / rows.length;
      // authored needles must not sit systematically above the haystack they compete with (importance scales the ranking score)
      expect(mean, "mean importance").toBeGreaterThan(2.6);
      expect(mean, "mean importance").toBeLessThan(3.1);
    }
    // authored on the row itself (or its long-context anchor), never left to the loader default
    expect(needles.filter(n => n.importance === undefined).map(n => n.id)).toEqual([]);
    // decisions outrank the reasons behind them
    for (const n of needles.filter(n => n.id.endsWith("-root"))) expect(n.importance!, n.id).toBeGreaterThanOrEqual(needles.find(a => a.id === n.id.replace("-root", "-answer"))!.importance! - 1);
  });

  // Guidance was 3 MB for the 338-query set (2.3 MB, 1,450 vectors). The expansion holds 4,304 vectors at about 1.6 KB
  // each (float32 embeddings barely compress): 6.8 MB, so 8 MiB leaves 1.6 MB with contextual embeddings off. Contextual
  // rows (T-0042) re-embed chunks: the 682 chunks of the 231 multi-chunk notes are about 1.1 MB and still fit; all 2,743
  // chunks (4.3 MB) do not, so those stay in the local cache, uncommitted. Past the cap, move the layer out of git.
  it("keeps the committed core replay layer within its size budget", () => {
    const bytes = statSync(resolve(DATA, `replay.${DEFAULTS.EMBEDDING_MODEL.split("/").pop()}.jsonl.gz`)).size;
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
  });

  it("clusters common-word queries by dense triple, so permutation twins share one cluster", () => {
    const spec = buildCorpus("core-1k");
    const byTriple = new Map<string, Set<string>>();
    for (const q of spec.queries.filter(q => q.category === "common-word")) {
      const triple = q.text.split(" ").filter(word => (DENSE_TOKENS as readonly string[]).includes(word)).sort().join(",");
      byTriple.set(triple, (byTriple.get(triple) ?? new Set()).add(q.clusterKey!));
    }
    for (const [triple, keys] of byTriple) expect(keys.size, triple).toBe(1);
    expect(spec.queries.filter(q => q.category === "common-word").length).toBeGreaterThan(byTriple.size);
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
    expect(needles.filter(n => n.id.startsWith("n-long-"))).toEqual(generated);
    const sentences = generated.map(n => new Set(n.content.match(/[^.]+\./g)!.map(sentence => sentence.trim())));
    for (let i = 0; i < sentences.length; i++) {
      for (let j = i + 1; j < sentences.length; j++) {
        const shared = [...sentences[i]].filter(sentence => sentences[j].has(sentence)).length;
        expect(shared, `${generated[i].id} vs ${generated[j].id}`).toBeLessThanOrEqual(3);
      }
    }
    for (const q of queries.filter(q => q.category === "long-context" && q.gold[0].id.startsWith("n-long-"))) {
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
    const common = queries.filter(q => q.category === "common-word" && !q.tags?.includes("correlated") && !q.tags?.includes("subset"));
    for (const q of common) {
      const words = q.text.split(" ");
      const triple = words.filter(isDense).sort();
      expect(triple.length, q.id).toBe(3);
      // only over-budget queries carry extra tokens, and those are the ordinary common ones
      const extra = words.filter(word => !isDense(word));
      if (q.tags?.includes("over-budget")) {
        expect(extra.length, q.id).toBeGreaterThanOrEqual(1);
        expect(extra.every(word => (COMMON_TOKENS as readonly string[]).includes(word)), q.id).toBe(true);
      } else expect(extra, q.id).toEqual([]);
      const gold = needles.find(n => n.id === q.gold[0].id)!;
      expect(dense(gold.content).sort(), q.id).toEqual(triple);
      expect(gold.ageDays, `${q.id} gold must be old enough to fall outside the LIKE window`).toBeGreaterThanOrEqual(300);
      expect(readScopeWorkspaces(IDENTITIES[q.viewer], { layer: q.layer }), q.id).toContain(WORKSPACES[gold.workspace]);
    }
    // The triple must be unique among the rows a viewer reads (avery: avery + company, blake: blake + company), not globally:
    // an avery-workspace note and a blake-workspace note may share one, since no viewer reads both.
    for (const viewer of ["avery", "blake"] as const) {
      const readable = new Set(readScopeWorkspaces(IDENTITIES[viewer], {}));
      const inScope = common.filter(q => readable.has(WORKSPACES[needles.find(n => n.id === q.gold[0].id)!.workspace]));
      const triples = inScope.map(q => q.text.split(" ").filter(isDense).sort().join(","));
      expect(new Set(triples).size, `distinct triples for ${viewer}`).toBe(triples.length);
    }
    const goldIds = new Set(common.map(q => q.gold[0].id));
    // as substrings, so "timetable" or "newsletter" count
    for (const n of needles.filter(n => !goldIds.has(n.id))) expect(dense(n.content).length, n.id).toBeLessThanOrEqual(2);
  });

  // T-0073 and T-0074 were scale-dependent: the LIKE window (newest 500 matches) holds every match at core-1k, so
  // these queries lost the gold only at scale-5k and scale-20k. The router now serves them from the index, so they
  // are ordinary queries (no known-gap tag) that stay in the set as the regression guard for that fix.
  const specs = new Map<string, ReturnType<typeof buildCorpus>>();
  const routeAt = (id: "core-1k" | "scale-5k" | "scale-20k", q: (typeof queries)[number]) => {
    if (!specs.has(id)) specs.set(id, buildCorpus(id));
    const spec = specs.get(id)!;
    const readable = new Set(readScopeWorkspaces(IDENTITIES[q.viewer], { layer: q.layer }));
    const visible = spec.entries.filter(e => readable.has(e.workspaceId)).map(entry => ({ entry, content: entry.content.toLowerCase() }));
    return keywordRouteModel(q.text, visible, spec.entries.find(e => e.id === q.gold[0].id)!.createdAt);
  };
  const FIXED_BUDGET = ["q-id-023-c", "q-id-030-c"];
  const FIXED_SHORT = ["q-id-007", "q-id-007-c", "q-id-024", "q-id-024-c", "q-id-035", "q-id-035-c", "q-short-027", "q-short-030"];

  it("keeps the fixed T-0073 queries as untagged regression guards that cross the budget on the bounded plan", () => {
    expect(queries.filter(q => q.tags?.includes("gap:T-0073") || q.tags?.includes("gap:T-0074")), "no query is a known route gap any more").toEqual([]);
    const overBudget = queries.filter(q => q.tags?.includes("over-budget") && q.id.startsWith("q-budget-"));
    expect(overBudget.map(q => q.id)).toEqual(Array.from({ length: 10 }, (_, i) => `q-budget-${String(i + 1).padStart(3, "0")}`));
    expect(new Set(overBudget.map(q => q.gold[0].id)).size, "one cluster per deliberate needle").toBe(10);
    // the deliberate tier crosses the budget at both scales; the identifier ones only at 20k, where the "roadmap" prefix and the key's variants are dense enough
    for (const id of ["scale-5k", "scale-20k"] as const) {
      for (const q of id === "scale-5k" ? overBudget : [...overBudget, ...queries.filter(q => FIXED_BUDGET.includes(q.id))]) {
        const model = routeAt(id, q);
        expect(model.dfSum, `${id} ${q.id} ${q.text}`).toBeGreaterThan(FTS_MATCH_BUDGET);
        expect(model.route, `${id} ${q.id}`).toBe("fts-bounded");
      }
    }
  }, 60_000);

  it("prices the bounded plan's AND tier with a correlated guard: three words that only co-occur, past the window and the budget", () => {
    const guard = queries.filter(q => q.tags?.includes("correlated"));
    expect(guard.map(q => q.id)).toEqual(["q-corr-001"]);
    expect(guard[0].tags).toContain("over-budget");
    for (const id of ["scale-5k", "scale-20k"] as const) {
      const model = routeAt(id, guard[0]);
      expect(model.route, id).toBe("fts-bounded");
      expect(model.dfSum, id).toBeGreaterThan(FTS_MATCH_BUDGET);
      const spec = specs.get(id)!;
      const together = spec.entries.filter(e => CORRELATED_TOKENS.every(t => e.content.toLowerCase().includes(t))).length;
      expect(together, `${id}: rows carrying all three`).toBeGreaterThan(KEYWORD_CANDIDATE_LIMIT);
    }
    // the gold is newer than all but a handful of the correlated rows, so the AND tier's newest-first scan keeps it
    for (const id of ["scale-5k", "scale-20k"] as const) {
      const rows = specs.get(id)!.entries;
      const together = rows.filter(e => CORRELATED_TOKENS.every(t => e.content.toLowerCase().includes(t)));
      expect(together.findIndex(e => e.id === "n-corr-001"), `${id}: gold's rank among correlated rows by insertion`).toBeGreaterThanOrEqual(together.length - KEYWORD_CANDIDATE_LIMIT);
    }
    // core-1k has no correlated rows: the guard is inert there, like every scale-dependent query
    expect(buildCorpus("core-1k").entries.filter(e => e.content.toLowerCase().includes("trellis")).map(e => e.id)).toEqual(["n-corr-001"]);
  }, 60_000);

  it("guards the OR tier with queries whose gold carries only a mid-df subset of the tokens, past the budget at both scales", () => {
    const guards = queries.filter(q => q.tags?.includes("subset"));
    expect(guards.map(q => q.id)).toEqual(Array.from({ length: 6 }, (_, i) => `q-sub-00${i + 1}`));
    for (const id of ["scale-5k", "scale-20k"] as const) {
      for (const q of guards) {
        const model = routeAt(id, q);
        expect(model.route, `${id} ${q.id}`).toBe("fts-bounded");
        expect(model.dfSum, `${id} ${q.id}`).toBeGreaterThan(FTS_MATCH_BUDGET);
      }
    }
  }, 60_000);

  it("keeps the fixed T-0074 queries as untagged regression guards that carry a short token to the index", () => {
    expect(queries.filter(q => FIXED_SHORT.includes(q.id)).map(q => q.id)).toEqual(FIXED_SHORT);
    for (const q of queries.filter(q => FIXED_SHORT.includes(q.id))) {
      const model = routeAt("scale-20k", q);
      expect(model.terms.some(t => [...t].length < FTS_MIN_TOKEN_LENGTH), `${q.id} carries a short token`).toBe(true);
      expect(["fts", "fts-bounded"], `${q.id}: ${model.route}`).toContain(model.route);
    }
  }, 60_000);

  it("answers every fixed query under the route model at every scale, and leaves no route gap for the audit to find", () => {
    for (const q of queries.filter(q => [...FIXED_BUDGET, ...FIXED_SHORT].includes(q.id) || q.tags?.includes("over-budget"))) {
      for (const id of ["core-1k", "scale-5k", "scale-20k"] as const) expect(routeAt(id, q).lost, `${q.id} at ${id}`).toBe(false);
    }
    expect(staleRouteGaps(["scale-5k", "scale-20k"].map(id => buildCorpus(id as "scale-5k")))).toEqual([]);
  }, 60_000);

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
    // the haystack is fixed per scale (HAYSTACK_ROWS), so growing the golden set never resizes it
    for (const id of CORPUS_IDS) {
      const total = HAYSTACK_ROWS[id] + needles.length;
      const spec = buildCorpus(id);
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
    // the haystack is fixed at the size the rates were solved for, whatever the needle count
    const haystack = buildCorpus("scale-5k").entries.filter(e => e.id.startsWith("f-")).length;
    expect(haystack).toBe(HAYSTACK_ROWS["scale-5k"]);
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
