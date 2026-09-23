import { NeuronBudget, ReplayStore, makeReplayAi, type LiveAi } from "./ai-replay";
import { loadCorpus } from "./corpus/loader";
import type { CorpusSpec } from "./corpus/types";
import { runVariant } from "./runner";
import type { VariantSpec } from "./variants";

/**
 * The only path that may reach Workers AI. Three passes:
 *  1. dry: learn which texts are missing and what recording them would cost;
 *  2. record: only if the estimate fits --max-neurons, embed each missing text once;
 *  3. replay: prove the cache is now complete (throws on any miss).
 * The same three passes are T-0042's corpus re-embedding step for an index variant.
 */
export async function prepare(o: {
  spec: CorpusSpec;
  variant: VariantSpec;
  backend: "sqlite" | "workerd";
  model: string;
  store: ReplayStore;
  live: LiveAi;
  maxNeurons: number;
  concurrency: number;
  log: (line: string) => void;
}): Promise<{ missing: number; estimatedNeurons: number; spentNeurons: number }> {
  const pass = async (replay: ReturnType<typeof makeReplayAi>, concurrency: number) => {
    const corpus = await loadCorpus({ spec: o.spec, backend: o.backend, replay, embeddingModel: o.model, index: o.variant.index, concurrency });
    try {
      await runVariant({ corpus, variant: o.variant, queries: o.spec.queries, isolate: "warm", embeddingModel: o.model });
    } finally {
      await corpus.close();
    }
  };

  const dry = makeReplayAi({ store: o.store, mode: "dry" });
  await pass(dry, 1);
  const missing = dry.misses.size;
  const estimatedNeurons = [...dry.misses.values()].reduce((s, m) => s + m.neurons, 0);
  o.log(`${missing} text(s) to record, estimated ${estimatedNeurons.toFixed(1)} neurons (cap ${o.maxNeurons}).`);

  let spentNeurons = 0;
  if (missing > 0) {
    if (estimatedNeurons > o.maxNeurons) {
      throw new Error(`estimated ${estimatedNeurons.toFixed(1)} neurons exceeds --max-neurons ${o.maxNeurons}; raise it deliberately (the free tier is 10,000 neurons per day and the product shares it)`);
    }
    const budget = new NeuronBudget(o.maxNeurons);
    await pass(makeReplayAi({ store: o.store, mode: "record", live: o.live, budget }), o.concurrency);
    spentNeurons = budget.spent;
    o.log(`recorded; estimated spend ${spentNeurons.toFixed(1)} neurons.`);
  }

  await pass(makeReplayAi({ store: o.store, mode: "replay" }), 1);
  o.log("replay verification passed: the cache is complete for this variant and corpus.");
  return { missing, estimatedNeurons, spentNeurons };
}
