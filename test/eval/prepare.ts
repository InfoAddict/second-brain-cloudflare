import { RERANK_MODEL } from "../../src/constants";
import { NeuronBudget, ReplayStore, makeReplayAi, type LiveAi, type LlmTagsArm } from "./ai-replay";
import { loadCorpus } from "./corpus/loader";
import type { CorpusSpec } from "./corpus/types";
import { runVariant } from "./runner";
import type { VariantSpec } from "./variants";

/** Dry-pass stand-in for the reranker: a valid answer in the documented shape (best first by index), so the pass can walk on and list the request it would record. */
export function dryReranker(model: string, input: unknown): unknown {
  if (model !== RERANK_MODEL) throw new Error(`no dry answer for ${model}`);
  const contexts = (input as { contexts?: unknown[] }).contexts ?? [];
  return { response: contexts.map((_, id) => ({ id, score: contexts.length - id })) };
}

/** How long the record pass lets one local reranker call run. Production allows RERANK_TIMEOUT_MS (a Workers AI budget); local CPU inference on a busy machine can exceed it, and a fallback would record nothing. */
export const RECORD_RERANK_TIMEOUT_MS = 10 * 60_000;

/**
 * The variant for the RECORD pass only: same flags, plus the eval-only reranker timeout. Dry, replay-verification and every
 * gate run keep the production timeout. The override rides on the typed variant flags (RecallVariantFlags.rerankTuning),
 * which no route or MCP path can set.
 */
export function withRecordTimeout(v: VariantSpec): VariantSpec {
  const flags = v.internal?.variant ?? {};
  return { ...v, internal: { ...v.internal, variant: { ...flags, rerankTuning: { ...flags.rerankTuning, timeoutMs: RECORD_RERANK_TIMEOUT_MS } } } };
}

/** Times the real reranker calls only; latency of embedding and tag calls is not what a recall pays for ranking. */
function timeReranker(live: LiveAi, ms: number[]): LiveAi {
  return { ...live, run: async (model, input) => {
    const started = performance.now();
    try { return await live.run(model, input); } finally { if (model === RERANK_MODEL) ms.push(performance.now() - started); }
  } };
}

const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

/**
 * The only path that runs live inference, and it is local (makeLocalAi: pinned open weights, no account, no
 * network beyond anonymous Hugging Face downloads). Three passes:
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
  /** Arm whose rows to record; the stand-in needs the query and tag embeddings, the empty arm needs none. Defaults to the stand-in. */
  llmTags?: LlmTagsArm;
  maxNeurons: number;
  concurrency: number;
  log: (line: string) => void;
}): Promise<{ missing: number; estimatedNeurons: number; spentNeurons: number }> {
  const pass = async (replay: ReturnType<typeof makeReplayAi>, concurrency: number, strict = false, variant: VariantSpec = o.variant) => {
    const corpus = await loadCorpus({ spec: o.spec, backend: o.backend, replay, embeddingModel: o.model, index: o.variant.index, concurrency });
    try {
      const report = await runVariant({ corpus, variant, queries: o.spec.queries, isolate: "warm", embeddingModel: o.model });
      // a swallowed miss (a stand-in's) shows up only as a query error, so the verification pass must read them
      const failed = report.results.filter(r => r.error);
      if (strict && failed.length) throw new Error(`replay verification failed on ${failed.length} query(ies), first: ${failed[0].queryId}: ${failed[0].error}`);
    } finally {
      await corpus.close();
    }
  };

  // every pass must read only a cache labeled with the producer that would fill it
  const expectProducer = (m: string) => o.live.producer?.(m);
  const dry = makeReplayAi({ store: o.store, mode: "dry", expectProducer, llmTags: o.llmTags, dryOther: dryReranker });
  await pass(dry, 1);
  const missing = dry.misses.size;
  const estimatedNeurons = [...dry.misses.values()].reduce((s, m) => s + m.neurons, 0);
  o.log(`${missing} text(s) to record, estimated ${estimatedNeurons.toFixed(1)} neurons (cap ${o.maxNeurons}).`);

  let spentNeurons = 0;
  if (missing > 0) {
    if (estimatedNeurons > o.maxNeurons) {
      throw new Error(`estimated ${estimatedNeurons.toFixed(1)} neurons exceeds --max-neurons ${o.maxNeurons}; raise it deliberately (the estimate is a byte-count upper bound in production-equivalent neurons)`);
    }
    const budget = new NeuronBudget(o.maxNeurons);
    const rerankMs: number[] = [];
    await pass(makeReplayAi({ store: o.store, mode: "record", live: timeReranker(o.live, rerankMs), budget, llmTags: o.llmTags }), o.concurrency, false, withRecordTimeout(o.variant));
    spentNeurons = budget.spent;
    o.log(`recorded; estimated spend ${spentNeurons.toFixed(1)} neurons.`);
    if (rerankMs.length) o.log(`reranker: ${rerankMs.length} local model call(s), p50 ${pct(rerankMs, 0.5).toFixed(0)} ms, p95 ${pct(rerankMs, 0.95).toFixed(0)} ms (local CPU inference, NOT Workers AI latency, which is unmeasured).`);
  }

  await pass(makeReplayAi({ store: o.store, mode: "replay", expectProducer, llmTags: o.llmTags }), 1, true);
  o.log("replay verification passed: the cache is complete for this variant and corpus.");
  return { missing, estimatedNeurons, spentNeurons };
}

/** Writes exactly the cache rows a baseline replay of this corpus uses, plus the producer records, as a gzipped layer. */
export async function exportCache(o: {
  spec: CorpusSpec;
  variant: VariantSpec;
  backend: "sqlite" | "workerd";
  model: string;
  readPaths: string[];
  outPath: string;
  /** Repo root for the store's path containment; tests point this at a temp dir. */
  root?: string;
  /** Arm whose rows count as used; the committed cache must carry the stand-in's embeddings. Defaults to the stand-in. */
  llmTags?: LlmTagsArm;
}): Promise<number> {
  const store = new ReplayStore(o.readPaths, undefined, { root: o.root });
  const corpus = await loadCorpus({ spec: o.spec, backend: o.backend, replay: makeReplayAi({ store, mode: "replay", llmTags: o.llmTags }), embeddingModel: o.model, index: o.variant.index });
  try {
    await runVariant({ corpus, variant: o.variant, queries: o.spec.queries, isolate: "warm", embeddingModel: o.model });
  } finally {
    await corpus.close();
  }
  return store.exportUsed(o.outPath);
}
