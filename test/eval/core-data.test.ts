import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KEYWORD_CANDIDATE_LIMIT } from "../../src/constants";
import { readScopeWorkspaces } from "../../src/lib/scope";
import { auditQueries, haystackVocabulary } from "./corpus/audit";
import { buildCorpus, loadCoreData } from "./corpus/build";
import { COMMON_TOKENS } from "./corpus/haystack";
import { IDENTITIES } from "./corpus/types";
import { QUERY_CATEGORIES } from "./types";

const DATA = resolve(import.meta.dirname, "data/core");
const MINIMUMS = { identifier: 36, "rare-word": 40, "common-word": 36, "short-word": 30, paraphrase: 48, cjk: 36, "multi-hop": 30, "long-context": 24 } as const;
const CLUSTER_MINIMUM = 30;

describe("core golden data", () => {
  const { needles, edges, queries } = loadCoreData();

  it("matches the manifest hashes, so any edit is deliberate (refresh with the lock command)", () => {
    const manifest = JSON.parse(readFileSync(resolve(DATA, "manifest.json"), "utf8")) as { files: Record<string, string> };
    for (const [name, hash] of Object.entries(manifest.files)) {
      expect(createHash("sha256").update(readFileSync(resolve(DATA, name))).digest("hex"), name).toBe(hash);
    }
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
      expect(clusters.size, category).toBeGreaterThanOrEqual(CLUSTER_MINIMUM > MINIMUMS[category] ? MINIMUMS[category] : CLUSTER_MINIMUM);
    }
  });

  it("has unique needle ids, valid edges, and fictional-only content", () => {
    expect(new Set(needles.map(n => n.id)).size).toBe(needles.length);
    const ids = new Set(needles.map(n => n.id));
    for (const e of edges) { expect(ids.has(e.source), e.source).toBe(true); expect(ids.has(e.target), e.target).toBe(true); }
    for (const n of needles) expect(n.content.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)?.every(m => m.endsWith("@example.com")) ?? true, n.id).toBe(true);
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
