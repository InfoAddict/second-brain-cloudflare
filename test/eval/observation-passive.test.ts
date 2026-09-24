import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { resetVectorizeFilterState } from "../../src/vectorize/scope";
import { ReplayStore, makeReplayAi } from "./ai-replay";
import { buildCorpus } from "./corpus/build";
import { loadCorpus } from "./corpus/loader";
import { EVAL_NOW, IDENTITIES } from "./corpus/types";
import { replayPaths } from "./corpora";
import { EVAL_TOP_K, freezeClock, withoutRecallCountWrites } from "./runner";

const MODEL = DEFAULTS.EMBEDDING_MODEL;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

// The eval always observes (diagnostics on); production does not. Observation must be purely passive, or the eval's
// rankings would differ from what production computes. The 'like' variant is the one whose distillation runs the
// first() statement that the observer executes as all().
describe("recall diagnostics are passive: observed and unobserved rankings are identical on core-1k", () => {
  it.each([["baseline", true], ["like", false]] as const)("%s", async (_name, ftsReady) => {
    const spec = buildCorpus("core-1k");
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore(replayPaths(MODEL, "core-1k").read), mode: "replay" }), embeddingModel: MODEL });
    const restore = freezeClock(EVAL_NOW);
    try {
      if (ftsReady) await corpus.env.OAUTH_KV.put(FTS_READY_KV_KEY, "1"); else await corpus.env.OAUTH_KV.delete(FTS_READY_KV_KEY);
      const env = { ...corpus.env, DB: withoutRecallCountWrites(corpus.env.DB, () => {}) } as typeof corpus.env;
      const cfg = Object.freeze({ ...DEFAULTS, EMBEDDING_MODEL: MODEL });
      const ids = async (q: (typeof spec.queries)[number], diagnostics?: RecallDiagnostics) => {
        resetFtsReadyMemo();
        resetVectorizeFilterState();
        const result = await corpus.replay.scope(q.id, () => recallEntries(
          { query: q.text, topK: EVAL_TOP_K, hops: q.hops, synthesize: false }, env, ctx, cfg,
          { identity: IDENTITIES[q.viewer], workspaceFilter: q.layer, ...(diagnostics && { diagnostics }) },
        ));
        await corpus.replay.settle(q.id);
        return result.matches.map(m => m.id);
      };
      const differ: string[] = [];
      for (const q of spec.queries) {
        const plain = await ids(q);
        const observed = await ids(q, {});
        if (JSON.stringify(plain) !== JSON.stringify(observed)) differ.push(q.id);
      }
      expect(differ).toEqual([]);
    } finally {
      restore();
      await corpus.close();
    }
  }, 300_000);
});
