import { describe, expect, it } from "vitest";
import { fuseDenseAndKeyword } from "../../src/recall/search";

/** A note's text whose toLowerCase calls are counted: a recall reads up to 500 notes of tens of KB, so lowercasing each once matters. */
function countedNote(text: string, calls: { n: number }): string {
  const s = new String(text) as String & { toLowerCase(): string };
  s.toLowerCase = () => { calls.n++; return text.toLowerCase(); };
  return s as unknown as string;
}

describe("keyword row lowercasing", () => {
  const rows = (calls: { n: number }) => ["Alpha Bravo note", "Alpha only note", "Charlie note", "Bravo Charlie note"].map((c, i) => ({ id: `r${i}`, content: countedNote(c, calls), tags: "[]", source: "api", created_at: i }));

  it("lowercases each row once however many views fuse it", () => {
    const calls = { n: 0 };
    const kw = rows(calls);
    const corpus = { df: new Map([["alpha", 2], ["bravo", 2]]), total: 10 };
    const a = fuseDenseAndKeyword([], kw as never, ["alpha", "bravo"], true, corpus, 0.25);
    const b = fuseDenseAndKeyword([], kw as never, ["alpha", "bravo", "charlie"], true, corpus, 0.25);
    expect(calls.n).toBe(kw.length);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
  });

  it("gives the same scores as lowercasing per view", () => {
    const fresh = () => rows({ n: 0 });
    const corpus = { df: new Map([["alpha", 2], ["bravo", 2]]), total: 10 };
    const shared = fresh();
    const first = fuseDenseAndKeyword([], shared as never, ["alpha", "bravo"], true, corpus, 0.25);
    const again = fuseDenseAndKeyword([], shared as never, ["alpha", "bravo"], true, corpus, 0.25);
    const alone = fuseDenseAndKeyword([], fresh() as never, ["alpha", "bravo"], true, corpus, 0.25);
    expect(again.map(m => [m.id, m.score])).toEqual(first.map(m => [m.id, m.score]));
    expect(alone.map(m => [m.id, m.score])).toEqual(first.map(m => [m.id, m.score]));
  });
});
