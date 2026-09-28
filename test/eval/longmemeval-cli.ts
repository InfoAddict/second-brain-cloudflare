/**
 * T-0089.1.4 phase A driver. Two steps, matching prepare.ts's own dry/record/replay discipline:
 *   1. record  -- embeds every distinct session and question text once (deduplicated by content,
 *      cached under .eval-cache/replay/longmemeval.<model-slug>.jsonl so it is never recomputed).
 *   2. score   -- one isolated per-question run per question (see longmemeval.ts's own comment on
 *      why), pure replay against the cache `record` filled, printing Recall@5/10 and NDCG@10 per
 *      category plus the original LongMemEval question_type breakdown.
 * `--sample N` runs on the first N retrieval-eligible questions only (in file order) -- a stratified
 * subset would need to preserve each question_type's own share; see CATEGORY_MAP and the report's
 * subset counts to check a sample stayed representative.
 * Usage: node scripts/eval-run-ts.mjs test/eval/longmemeval-cli.ts record [--sample N] [--max-neurons N] [--concurrency N]
 *        node scripts/eval-run-ts.mjs test/eval/longmemeval-cli.ts score [--sample N]
 */
import { performance } from "node:perf_hooks";
import { makeReplayAi, ReplayStore } from "./ai-replay";
import { replayPaths } from "./corpora";
import { makeLocalAi } from "./local-ai";
import { prepare } from "./prepare";
import { EMBEDDING_MODEL, buildRecordingCorpus, loadLongMemEvalData, scoreQuestions } from "./longmemeval";
import { getVariant } from "./variants";
import type { QueryResult } from "./types";

function parseArgs(argv: string[]): { cmd: string; sample?: number; maxNeurons: number; concurrency: number } {
  const [cmd, ...rest] = argv;
  const flag = (name: string, dflt: number) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? dflt : Number(rest[i + 1]);
  };
  const sampleIdx = rest.indexOf("--sample");
  return {
    cmd, sample: sampleIdx === -1 ? undefined : Number(rest[sampleIdx + 1]),
    maxNeurons: flag("max-neurons", 50_000), concurrency: flag("concurrency", 2),
  };
}

async function runRecord(sample: number | undefined, maxNeurons: number, concurrency: number): Promise<void> {
  const full = buildRecordingCorpus();
  const spec = sample === undefined ? full : { ...full, queries: full.queries.slice(0, sample) };
  const usedSessionIds = sample === undefined ? undefined : new Set(
    loadLongMemEvalData().questions.slice(0, sample).flatMap(q => q.haystack),
  );
  if (usedSessionIds) spec.entries = spec.entries.filter(e => usedSessionIds.has(e.id));
  console.log(`record: ${spec.queries.length} question(s), ${spec.entries.length} distinct session(s).`);

  const paths = replayPaths(EMBEDDING_MODEL, "longmemeval");
  const started = performance.now();
  const result = await prepare({
    spec, variant: getVariant("baseline"), backend: "sqlite", model: EMBEDDING_MODEL,
    store: new ReplayStore(paths.read, paths.write), live: makeLocalAi(),
    maxNeurons, concurrency, log: (line) => console.log(line),
  });
  const wallMs = performance.now() - started;
  const perText = result.missing > 0 ? wallMs / result.missing : 0;
  console.log(`record pass: ${result.missing} text(s) newly embedded in ${(wallMs / 1000).toFixed(1)}s (${perText.toFixed(0)} ms/text average, concurrency ${concurrency}).`);
}

function summarize(results: QueryResult[]): void {
  const byCategory = new Map<string, QueryResult[]>();
  const bySubset = new Map<string, QueryResult[]>();
  for (const r of results) {
    (byCategory.get(r.category) ?? byCategory.set(r.category, []).get(r.category)!).push(r);
    const subset = r.tags?.find(t => t.startsWith("subset:")) ?? "subset:unknown";
    (bySubset.get(subset) ?? bySubset.set(subset, []).get(subset)!).push(r);
  }
  const avg = (rows: QueryResult[], key: "recall5" | "recall10" | "ndcg10" | "mrr10") =>
    (rows.reduce((s, r) => s + (r.metrics[key] ?? 0), 0) / rows.length).toFixed(3);
  console.log(`\noverall (${results.length} questions): recall@5=${avg(results, "recall5")} recall@10=${avg(results, "recall10")} ndcg@10=${avg(results, "ndcg10")} mrr@10=${avg(results, "mrr10")}`);
  console.log("by mapped category:");
  for (const [cat, rows] of [...byCategory].sort()) console.log(`  ${cat}: n=${rows.length} recall@10=${avg(rows, "recall10")} ndcg@10=${avg(rows, "ndcg10")}`);
  console.log("by LongMemEval question_type:");
  for (const [subset, rows] of [...bySubset].sort()) console.log(`  ${subset}: n=${rows.length} recall@10=${avg(rows, "recall10")} ndcg@10=${avg(rows, "ndcg10")}`);
  const errors = results.filter(r => r.error);
  if (errors.length) console.log(`\n${errors.length} question(s) errored, first: ${errors[0].queryId}: ${errors[0].error}`);
}

async function runScore(sample: number | undefined): Promise<void> {
  const { sessions, questions: all } = loadLongMemEvalData();
  const questions = sample === undefined ? all : all.slice(0, sample);
  const paths = replayPaths(EMBEDDING_MODEL, "longmemeval");
  const replay = makeReplayAi({ store: new ReplayStore(paths.read), mode: "replay" });
  const started = performance.now();
  const results = await scoreQuestions({
    questions, sessions, replay, embeddingModel: EMBEDDING_MODEL, backend: "sqlite",
    onProgress: (done, total) => { if (done % 25 === 0 || done === total) console.log(`scored ${done}/${total}`); },
  });
  const wallMs = performance.now() - started;
  console.log(`score pass: ${questions.length} question(s) in ${(wallMs / 1000).toFixed(1)}s (${(wallMs / questions.length).toFixed(0)} ms/question average).`);
  summarize(results);
}

async function main(): Promise<void> {
  const { cmd, sample, maxNeurons, concurrency } = parseArgs(process.argv.slice(2));
  if (cmd === "record") return runRecord(sample, maxNeurons, concurrency);
  if (cmd === "score") return runScore(sample);
  console.error("usage: longmemeval-cli.ts <record|score> [--sample N] [--max-neurons N] [--concurrency N]");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
