import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FTS_MATCH_BUDGET, KEYWORD_CANDIDATE_LIMIT } from "../../src/constants";
import { readScopeWorkspaces } from "../../src/lib/scope";
import { tokenizeQuery } from "../../src/text/tokenize";
import { longContextNeedles, mechanicalQueries } from "./corpus/author";
import { auditQueries, haystackVocabulary } from "./corpus/audit";
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

  it("matches the manifest hashes, so any edit is deliberate (refresh with the lock command)", () => {
    const manifest = JSON.parse(readFileSync(resolve(DATA, "manifest.json"), "utf8")) as { files: Record<string, string> };
    const onDisk = readdirSync(DATA).filter(name => name.endsWith(".jsonl")).sort();
    expect(Object.keys(manifest.files).sort()).toEqual(onDisk);
    for (const [name, hash] of Object.entries(manifest.files)) {
      expect(createHash("sha256").update(readFileSync(resolve(DATA, name))).digest("hex"), name).toBe(hash);
    }
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

  it("pins the known-gap queries, so fixing T-0072 must consciously remove the tags", () => {
    const gaps = queries.filter(q => q.tags?.includes("gap:T-0072"));
    expect(gaps.map(q => q.id)).toEqual([
      "q-id-037", "q-id-038", "q-id-038-c", "q-id-039", "q-id-040", "q-id-040-c", "q-id-041", "q-id-042", "q-id-043", "q-id-044", "q-id-045", "q-id-046",
    ]);
    expect(new Set(gaps.map(q => q.tags!.filter(tag => tag.startsWith("gap:")).join()))).toEqual(new Set(["gap:T-0072"]));
    expect(new Set(gaps.map(q => q.clusterKey ?? q.gold[0].id)).size, "one cluster per needle").toBe(10);
    // every one is an underscore identifier, and each key is rare in the corpus as written (df 1-2 at 20k)
    const spec = buildCorpus("scale-20k");
    for (const q of gaps) {
      const key = needles.find(n => n.id === q.gold[0].id)!.keys![0];
      expect(key, q.id).toContain("_");
      expect(q.text.endsWith(key), q.id).toBe(true);
      const df = spec.entries.filter(e => e.content.toLowerCase().includes(key.toLowerCase())).length;
      expect(df, `${q.id} ${key}`).toBeGreaterThanOrEqual(1);
      expect(df, `${q.id} ${key}`).toBeLessThanOrEqual(2);
    }
    expect(gaps.filter(q => q.id.endsWith("-c")).length, "common-token-prefixed variants").toBeGreaterThanOrEqual(2);
    // every known-gap query names exactly one of the two boarded gaps
    for (const q of queries.filter(q => q.tags?.includes("known-gap"))) expect(q.tags!.filter(tag => tag.startsWith("gap:")).length, q.id).toBe(1);
    // an underscore identifier anywhere else must be tagged, so none slips into the set unmeasured
    const untagged = queries.filter(q => q.category === "identifier" && q.text.includes("_") && !q.tags?.includes("known-gap"));
    expect(untagged.map(q => q.id)).toEqual([]);
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
      // only router-budget queries carry extra tokens, and those are the ordinary common ones
      const extra = words.filter(word => !isDense(word));
      if (q.tags?.includes("router-budget")) {
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

  it("pins the router-budget queries and shows each crosses the FTS budget at 5k and 20k, but not necessarily at 1k", () => {
    const gaps = queries.filter(q => q.tags?.includes("router-budget"));
    expect(gaps.map(q => q.id)).toEqual(Array.from({ length: 10 }, (_, i) => `q-budget-${String(i + 1).padStart(3, "0")}`));
    for (const q of gaps) expect(q.tags, q.id).toEqual(["router-budget", "known-gap", "gap:T-0073"]);
    expect(new Set(gaps.map(q => q.gold[0].id)).size, "one cluster per needle").toBe(10);
    for (const id of ["scale-5k", "scale-20k"] as const) {
      const spec = buildCorpus(id);
      for (const q of gaps) {
        const readable = new Set(readScopeWorkspaces(IDENTITIES[q.viewer], { layer: q.layer }));
        const rows = spec.entries.filter(e => readable.has(e.workspaceId)).map(e => e.content.toLowerCase());
        const dfSum = tokenizeQuery(q.text).reduce((sum, token) => sum + rows.filter(row => row.includes(token)).length, 0);
        expect(dfSum, `${id} ${q.id} ${q.text}`).toBeGreaterThan(FTS_MATCH_BUDGET);
      }
    }
  });

  it("keeps every rare and identifier key out of the haystack vocabulary", () => {
    const vocab = haystackVocabulary();
    for (const n of needles.filter(n => n.purpose === "rare-word" || n.purpose === "identifier")) {
      for (const key of n.keys ?? []) expect(vocab.has(key.toLowerCase()), key).toBe(false);
    }
  });

  it("passes the query audit on the whole core set, on every corpus size", () => {
    for (const id of ["core-1k", "scale-5k", "scale-20k"] as const) {
      const spec = buildCorpus(id);
      const findings = auditQueries({ entries: spec.entries, edges: spec.edges, queries: spec.queries });
      expect(findings, `${id}: ${JSON.stringify(findings.slice(0, 10), null, 1)}`).toEqual([]);
    }
  });

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
