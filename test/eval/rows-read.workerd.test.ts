import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import { ReplayStore, makeReplayAi } from "./ai-replay";
import { buildCorpus } from "./corpus/build";
import { loadCorpus } from "./corpus/loader";
import { replayPaths } from "./corpora";
import { runVariant } from "./runner";
import { getVariant } from "./variants";

const MODEL = DEFAULTS.EMBEDDING_MODEL;

// Opt-in: boots a local workerd. Every recall statement must have its rows_read counted: recall's corpus-frequency
// probe (distill.ts) is a first() call, which returns no meta unless the observer runs it as all().
describe.skipIf(!process.env.EVAL_WORKERD)("workerd rows_read on the whole core-1k golden set", () => {
  it("is measured for every query, so the cost rule can reach a verdict", async () => {
    const spec = buildCorpus("core-1k");
    const corpus = await loadCorpus({ spec, backend: "workerd", replay: makeReplayAi({ store: new ReplayStore(replayPaths(MODEL, "core-1k").read), mode: "replay" }), embeddingModel: MODEL });
    try {
      const report = await runVariant({ corpus, variant: getVariant("baseline"), queries: spec.queries, isolate: "warm", embeddingModel: MODEL });
      expect(report.results).toHaveLength(338);
      const missing = report.results.filter(r => r.cost.d1RowsRead === null).map(r => r.queryId);
      expect(missing, `${missing.length} queries have no rows_read`).toEqual([]);
      expect(report.results.every(r => (r.cost.d1RowsRead as number) > 0)).toBe(true);
    } finally {
      await corpus.close();
    }
  }, 1_200_000);
});
