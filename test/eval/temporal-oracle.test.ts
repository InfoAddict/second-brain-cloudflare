import { describe, expect, it } from "vitest";
import { ACTORS, EVAL_NOW, WORKSPACES, type CorpusEntry, type CorpusSpec } from "./corpus/types";
import { oracleTable, simulate, validAt } from "./temporal-oracle";
import { RUNNER_VERSION, type GoldenQuery, type QueryResult, type VariantReport } from "./types";

const DAY = 86_400_000;
const e = (id: string, day: number, extra: Partial<CorpusEntry> = {}): CorpusEntry =>
  ({ id, content: id, tags: [], source: "api", createdAt: EVAL_NOW - day * DAY, workspaceId: WORKSPACES.avery, actorId: ACTORS.avery, ...extra });

describe("validAt", () => {
  it("defaults validity to creation onward and ends it at validUntil or a retraction, whichever is first", () => {
    const doc = e("a", 10);
    expect(validAt(doc, doc.createdAt - 1)).toBe(false);
    expect(validAt(doc, EVAL_NOW)).toBe(true);
    expect(validAt(e("b", 10, { validUntil: EVAL_NOW - 3 * DAY }), EVAL_NOW - 2 * DAY)).toBe(false);
    expect(validAt(e("c", 10, { retractedAt: EVAL_NOW - 3 * DAY, validUntil: EVAL_NOW - 1 * DAY }), EVAL_NOW - 2 * DAY)).toBe(false);
  });
  it("lets validFrom precede createdAt for a backdated fact", () => {
    const backdated = e("d", 5, { validFrom: EVAL_NOW - 60 * DAY });
    expect(validAt(backdated, EVAL_NOW - 30 * DAY)).toBe(true);
  });
});

describe("simulate and oracleTable", () => {
  const old = e("old", 60, { validUntil: EVAL_NOW - 20 * DAY }), fresh = e("new", 20), recap = e("recap", 2, { validFrom: EVAL_NOW - 60 * DAY, validUntil: EVAL_NOW - 20 * DAY });
  const spec: CorpusSpec = {
    id: "t", intent: "tie", entries: [old, fresh, recap], edges: [],
    queries: [{ id: "now", category: "knowledge-update", text: "where now", gold: [{ id: "new", grade: 2 }], viewer: "avery", tags: ["subset:current"] } satisfies GoldenQuery],
  };
  const byId = new Map(spec.entries.map(x => [x.id, x] as const));
  const cost = { d1Statements: 0, d1RowsRead: null, aiCalls: 0, embeddingCalls: 0, vectorizeQueries: 0, kvReads: 0, neurons: 0, neuronsEstimated: false, wallMs: 0 };

  it("supersession drops documents invalid at the question date and keeps the rest in order", () => {
    expect(simulate("supersession", ["old", "recap", "new"], spec.queries[0], byId)).toEqual(["new"]);
  });
  it("uses expectedAsOf, then asOf, for past questions", () => {
    const past = { ...spec.queries[0], expectedAsOf: EVAL_NOW - 40 * DAY };
    expect(simulate("supersession", ["old", "recap", "new"], past, byId)).toEqual(["old", "recap"]);
  });
  it("the oracle places beliefs below valid documents rather than dropping them (T-0089.2.6)", () => {
    const belief = e("bad", 30, { validUntil: EVAL_NOW - 30 * DAY, retractedAt: EVAL_NOW - 10 * DAY });
    const byIdWithBelief = new Map([...byId, [belief.id, belief]]);
    // "bad" is invalid at now (like old/recap) but, unlike them, carries retractedAt: it stays in the ranking,
    // demoted below the valid "new", instead of being dropped like an ordinary superseded document.
    expect(simulate("supersession", ["bad", "old", "new"], spec.queries[0], byIdWithBelief)).toEqual(["new", "bad"]);
  });
  it("recency puts the newest-created document first, which the backdated recap wins", () => {
    expect(simulate("recency", ["old", "new", "recap"], spec.queries[0], byId)).toEqual(["recap", "new", "old"]);
  });
  it("tabulates baseline, supersession and recency per category and subset", () => {
    const result: QueryResult = { queryId: "now", category: "knowledge-update", clusterKey: "now", tags: ["subset:current"], rankedIds: ["old", "recap", "new"], leaked: [], metrics: { recall5: 1, recall10: 1, mrr10: 1 / 3, ndcg10: 0 }, cost };
    const report: VariantReport = { schema: 1, variant: "baseline", corpus: "t", embeddingModel: "m", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: RUNNER_VERSION, results: [result] };
    const rows = oracleTable(report, spec);
    expect(rows.map(r => r.scope)).toEqual(["knowledge-update", "knowledge-update subset:current"]);
    expect(rows[0]).toMatchObject({ n: 1, baseline: { mrr10: 1 / 3 }, supersession: { mrr10: 1 }, recency: { mrr10: 1 / 2 } });
  });
});
