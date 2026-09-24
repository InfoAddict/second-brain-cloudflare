import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import { ReplayStore, makeReplayAi } from "./ai-replay";
import { buildCorpus, CORE_DATA_DIR } from "./corpus/build";
import { loadCorpus } from "./corpus/loader";
import { COMMITTED_LAYER_VARIANTS } from "./prepare";
import { runVariant } from "./runner";
import { getVariant, type VariantSpec } from "./variants";

const MODEL = DEFAULTS.EMBEDDING_MODEL;
const COMMITTED = resolve(CORE_DATA_DIR, `replay.${MODEL.split("/").pop()}.jsonl.gz`);

// calibration.test.ts registers this one itself; the committed layer must cover it too.
const SABOTAGE: VariantSpec = { name: "sabotage", description: "Keyword arm keeps one candidate; MMR ignores relevance.", config: { KEYWORD_CANDIDATE_LIMIT: 1, MMR_LAMBDA: 0, RERANK_MODE: "off" } };

// CI is a clean checkout with no .eval-cache, so the default suite may replay ONLY the committed layer. A developer's
// local cache hides a row the layer lacks, so this reads the committed layer alone, whatever the local cache holds.
describe("the committed replay layer alone serves every variant the default suite runs", () => {
  it("has every row core-1k needs, for every variant, with no cache miss", async () => {
    expect(existsSync(COMMITTED)).toBe(true);
    const spec = buildCorpus("core-1k");
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore([COMMITTED]), mode: "replay" }), embeddingModel: MODEL });
    try {
      const failed: Record<string, string[]> = {};
      for (const variant of [...COMMITTED_LAYER_VARIANTS.map(name => getVariant(name)), SABOTAGE]) {
        const report = await runVariant({ corpus, variant, queries: spec.queries, isolate: "warm", embeddingModel: MODEL });
        const errors = report.results.filter(r => r.error).map(r => `${r.queryId}: ${r.error}`);
        if (errors.length) failed[variant.name] = errors.slice(0, 3);
      }
      expect(failed).toEqual({});
    } finally {
      await corpus.close();
    }
  }, 1_800_000);
});
