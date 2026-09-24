import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import { ReplayStore, makeReplayAi } from "./ai-replay";
import { buildCorpus, CORE_DATA_DIR, type CoreCorpusId } from "./corpus/build";
import { loadCorpus } from "./corpus/loader";
import { replayPaths } from "./corpora";
import { runVariant } from "./runner";
import { getVariant } from "./variants";

const MODEL = DEFAULTS.EMBEDDING_MODEL;
const PINNED = JSON.parse(readFileSync(resolve(CORE_DATA_DIR, "../baselines/router-guards.json"), "utf8")) as Record<string, Record<string, boolean>>;

// Opt-in: the 5k and 20k replay caches are local (.eval-cache/replay, built by `prepare`), never committed, so CI cannot run
// this. The router guards (over-budget, correlated, subset) only bite at these scales, and fusion can bury a gold the keyword
// arm retrieved, so rankings alone cannot pin them: this pins whether the arm retrieved the gold. Re-pin by rewriting
// test/eval/data/baselines/router-guards.json from `--variant baseline --corpus <id> --json` (keywordGold of the guard queries).
describe.skipIf(!process.env.EVAL_SCALE_GUARDS)("router guards at scale (keyword-arm gold coverage)", () => {
  for (const id of ["scale-5k", "scale-20k"] as CoreCorpusId[]) {
    it(`${id}: every pinned guard is still retrieved by the keyword arm, or still is not`, async () => {
      const spec = buildCorpus(id);
      const corpus = await loadCorpus({ spec, backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore(replayPaths(MODEL, id).read), mode: "replay" }), embeddingModel: MODEL });
      try {
        const guards = spec.queries.filter(q => q.tags?.some(t => t === "subset" || t === "correlated" || t === "over-budget"));
        const report = await runVariant({ corpus, variant: getVariant("baseline"), queries: guards, isolate: "warm", embeddingModel: MODEL });
        const now = Object.fromEntries(report.results.map(r => [r.queryId, r.keywordGold]));
        expect(now, `keyword-arm coverage of the router guards moved at ${id}; if intended, re-pin router-guards.json with the measurement`).toEqual(PINNED[id]);
      } finally {
        await corpus.close();
      }
    }, 900_000);
  }
});
