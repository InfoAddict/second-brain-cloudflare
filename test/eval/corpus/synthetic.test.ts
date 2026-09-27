import { describe, expect, it } from "vitest";
import { buildSyntheticCorpus, SYNTHETIC_CORPORA } from "./synthetic";

describe("synthetic quality-gate corpora", () => {
  it("rebuilds every seeded corpus byte for byte", () => {
    for (const id of SYNTHETIC_CORPORA) expect(buildSyntheticCorpus(id)).toEqual(buildSyntheticCorpus(id));
    for (const id of SYNTHETIC_CORPORA) expect(buildSyntheticCorpus(id, 7).dataFingerprint).not.toEqual(buildSyntheticCorpus(id, 8).dataFingerprint);
  });

  it("pairs dated contradictions with current and as-of questions", () => {
    const corpus = buildSyntheticCorpus("temporal");
    expect(corpus.entries).toHaveLength(240);
    expect(corpus.queries).toHaveLength(240);
    for (let i = 0; i < 120; i++) {
      const old = corpus.entries.find(e => e.id === `tm-old-${i}`)!;
      const newer = corpus.entries.find(e => e.id === `tm-new-${i}`)!;
      const past = corpus.queries.find(q => q.id === `tm-past-${i}`)!;
      expect(old.createdAt).toBeLessThan(past.asOf!);
      expect(past.asOf).toBeLessThan(newer.createdAt);
      expect(past.gold[0].id).toBe(old.id);
      expect(corpus.queries.find(q => q.id === `tm-current-${i}`)!.gold[0].id).toBe(newer.id);
    }
  });

  it("includes footer noise, repeat notices, and user notes with sources", () => {
    const corpus = buildSyntheticCorpus("noise");
    expect(corpus.entries.filter(e => e.source === "email-gmail")).toHaveLength(292);
    expect(corpus.entries.filter(e => e.content.includes("Subject: Direct deposit complete"))).toHaveLength(4);
    expect(new Set(corpus.entries.filter(e => e.id.startsWith("nz-mail-")).map(e => e.content.split("\n")[0])).size).toBe(12);
    expect(corpus.queries).toHaveLength(24);
    expect(corpus.queries.every(q => corpus.entries.find(e => e.id === q.gold[0].id)?.source === "api")).toBe(true);
  });

  it("plants 1 to 2 percent instruction emails and labels targeted gold", () => {
    const corpus = buildSyntheticCorpus("injection");
    const planted = corpus.entries.filter(e => e.id.startsWith("ij-plant-"));
    expect(planted).toHaveLength(7);
    expect(planted.length / corpus.entries.length).toBeGreaterThanOrEqual(0.01);
    expect(planted.length / corpus.entries.length).toBeLessThanOrEqual(0.02);
    expect(corpus.queries).toHaveLength(7);
    expect(corpus.queries.every(q => q.gold.every(g => !planted.some(e => e.id === g.id)))).toBe(true);
  });

  it("has 30 standing memories, five positive and ten negative paraphrases each", () => {
    const corpus = buildSyntheticCorpus("standing");
    expect(corpus.entries).toHaveLength(30);
    expect(corpus.queries.filter(q => q.tags?.includes("standing:yes"))).toHaveLength(150);
    expect(corpus.queries.filter(q => q.tags?.includes("standing:no"))).toHaveLength(300);
    expect(corpus.queries.filter(q => q.tags?.includes("standing:no")).every(q => q.gold.length === 0)).toBe(true);
  });
});
