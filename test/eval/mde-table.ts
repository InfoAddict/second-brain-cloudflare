// Prints the minimum detectable effect (MDE = 2.8 x bootstrap standard error over clusters, recall@10 unless stated)
// of each comparison against baseline: the calibration variants plus mild ones whose real effect is small, the size
// of change the gate is meant to catch. Offline: replays the recorded cache.
// Usage: node scripts/eval-run-ts.mjs test/eval/mde-table.ts [--corpus core-1k] [--metric recall10|mrr10|ndcg10] [--only like,sabotage]
import { DEFAULTS } from "../../src/config";
import { ReplayStore, makeReplayAi } from "./ai-replay";
import { buildCorpus, type CoreCorpusId } from "./corpus/build";
import { loadCorpus } from "./corpus/loader";
import { replayPaths } from "./corpora";
import { evaluateGate } from "./gate";
import { runVariant } from "./runner";
import { QUERY_CATEGORIES, type MetricName } from "./types";
import { getVariant, registerVariant } from "./variants";

const flag = (name: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const corpusId = (flag("--corpus") ?? "core-1k") as CoreCorpusId;
const metric = (flag("--metric") ?? "recall10") as MetricName;
const MODEL = DEFAULTS.EMBEDDING_MODEL;

registerVariant({ name: "sabotage", description: "KEYWORD_CANDIDATE_LIMIT 1 and MMR_LAMBDA 0.", config: { KEYWORD_CANDIDATE_LIMIT: 1, MMR_LAMBDA: 0 } });
registerVariant({ name: "mild-mmr", description: "MMR_LAMBDA 0.6 (a little more diversity).", config: { MMR_LAMBDA: 0.6 } });
registerVariant({ name: "mild-graph", description: "GRAPH_HOP_DECAY 0.45 (weaker neighbour scores).", config: { GRAPH_HOP_DECAY: 0.45 } });
registerVariant({ name: "mild-recency", description: "RECENCY_FLOOR 0.5 (older notes lose a little more).", config: { RECENCY_FLOOR: 0.5 } });
registerVariant({ name: "mild-tags", description: "TAG_BOOST_STEP 0.05 (weaker tag boost).", config: { TAG_BOOST_STEP: 0.05 } });

const spec = buildCorpus(corpusId);
const corpus = await loadCorpus({ spec, backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore(replayPaths(MODEL, corpusId).read), mode: "replay" }), embeddingModel: MODEL });
try {
  const run = (name: string) => runVariant({ corpus, variant: getVariant(name), queries: spec.queries, isolate: "warm", embeddingModel: MODEL });
  const baseline = await run("baseline");
  const names = flag("--only")?.split(",") ?? ["like", "dense-only", "keyword-only", "sabotage", "mild-mmr", "mild-graph", "mild-recency", "mild-tags"];
  const shortCat = (c: string) => c.replace("-word", "").replace("long-context", "long").replace("multi-hop", "hop").replace("identifier", "ident").replace("paraphrase", "para");
  console.log(`corpus ${corpusId}, ${spec.entries.length} entries, ${spec.queries.length} queries; MDE of ${metric}, 2.8 x bootstrap SE`);
  console.log(["comparison", "delta", "MDE all", ...QUERY_CATEGORIES.map(shortCat)].join(" | "));
  for (const name of names) {
    const gate = evaluateGate(baseline, await run(name), { allowUnmeasuredRowsRead: true });
    const at = (scope: string) => gate.deltas.find(d => d.scope === scope && d.metric === metric)!;
    const cell = (scope: string) => (2.8 * at(scope).ci.se).toFixed(4);
    const overall = at("overall");
    console.log([name, overall.ci.mean.toFixed(4), cell("overall"), ...QUERY_CATEGORIES.map(cell)].join(" | ") + `   (clusters ${overall.ci.clusters}, n ${overall.ci.n})`);
  }
} finally {
  await corpus.close();
}
