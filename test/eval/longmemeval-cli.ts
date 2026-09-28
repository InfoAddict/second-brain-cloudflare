/**
 * T-0089.1.4 phase A driver. Two steps, matching prepare.ts's own dry/record/replay discipline:
 *   1. record  -- one prepare() pass PER QUESTION, against that question's own isolated corpus
 *      (questionCorpus, the exact shape scoreQuestions replays against) -- recording against the
 *      single combined buildRecordingCorpus() instead looked more efficient but was wrong: recall's
 *      own routing (which arms fire, whether the reranker or a keyword/tag call runs at all) depends
 *      on corpus size, so a 2,000-entry combined corpus does not reliably record what a 40-entry
 *      per-question corpus needs at score time. Session and query text embeddings are still cached
 *      by content, so a text recorded once is never re-embedded just because a later question's
 *      corpus also contains it -- only the size-routed calls (reranker, keyword tags) repeat.
 *   2. score   -- the same per-question runs, pure replay against the cache `record` filled,
 *      printing Recall@5/10 per category plus the original LongMemEval question_type breakdown,
 *      with a 95% Wilson interval per type (test/eval/standing.ts's own wilson()) -- small per-type
 *      n means wide intervals, which is the honest picture, not a bug in the report.
 * `--stratified N` selects N questions with each question_type's own proportional share (rounded,
 * minimum 1 per type present), in file order within each type -- deterministic and reproducible.
 * `--sample N` (unstratified, first N in file order) is kept for quick smoke runs.
 * A sample run (< all questions) is always labeled as such in the score report: sample results, not
 * the full benchmark -- recall@k at n=50 or less carries real sampling uncertainty, shown via the CI.
 * Usage: node scripts/eval-run-ts.mjs test/eval/longmemeval-cli.ts record [--stratified N | --sample N] [--max-neurons N] [--concurrency N]
 *        node scripts/eval-run-ts.mjs test/eval/longmemeval-cli.ts score [--stratified N | --sample N]
 */
import { performance } from "node:perf_hooks";
import { makeReplayAi, ReplayStore } from "./ai-replay";
import { replayPaths } from "./corpora";
import { makeLocalAi } from "./local-ai";
import { prepare } from "./prepare";
import { EMBEDDING_MODEL, loadLongMemEvalData, questionCorpus, scoreQuestions, type RawQuestion } from "./longmemeval";
import { getVariant } from "./variants";
import { wilson } from "./standing";
import type { QueryResult } from "./types";

function parseArgs(argv: string[]): { cmd: string; sample?: number; stratified?: number; maxNeurons: number; concurrency: number } {
  const [cmd, ...rest] = argv;
  const flag = (name: string, dflt: number) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? dflt : Number(rest[i + 1]);
  };
  const idx = (name: string) => rest.indexOf(`--${name}`);
  const sampleIdx = idx("sample"), stratifiedIdx = idx("stratified");
  return {
    cmd,
    sample: sampleIdx === -1 ? undefined : Number(rest[sampleIdx + 1]),
    stratified: stratifiedIdx === -1 ? undefined : Number(rest[stratifiedIdx + 1]),
    maxNeurons: flag("max-neurons", 50_000), concurrency: flag("concurrency", 2),
  };
}

/** N questions with each question_type's own proportional share (rounded, at least 1 per type
 * present), first in file order within each type -- deterministic, so record and score select the
 * identical set from the same n without needing to pass ids between the two commands. */
export function selectStratified(questions: readonly RawQuestion[], n: number): { sample: RawQuestion[]; counts: Record<string, number> } {
  const byType = new Map<string, RawQuestion[]>();
  for (const q of questions) (byType.get(q.category) ?? byType.set(q.category, []).get(q.category)!).push(q);
  const counts: Record<string, number> = {};
  const sample: RawQuestion[] = [];
  for (const [type, list] of [...byType].sort(([a], [b]) => a.localeCompare(b))) {
    const want = Math.max(1, Math.round((n * list.length) / questions.length));
    counts[type] = want;
    sample.push(...list.slice(0, want));
  }
  return { sample, counts };
}

function selectQuestions(all: RawQuestion[], o: { sample?: number; stratified?: number }): { questions: RawQuestion[]; counts?: Record<string, number>; isSample: boolean } {
  if (o.stratified !== undefined) {
    const { sample, counts } = selectStratified(all, o.stratified);
    return { questions: sample, counts, isSample: true };
  }
  if (o.sample !== undefined) return { questions: all.slice(0, o.sample), isSample: true };
  return { questions: all, isSample: false };
}

async function runRecord(o: { sample?: number; stratified?: number; maxNeurons: number; concurrency: number }): Promise<void> {
  const { sessions, questions: all } = loadLongMemEvalData();
  const { questions, counts } = selectQuestions(all, o);
  if (counts) console.log(`stratified sample, per question_type: ${JSON.stringify(counts)}`);
  const distinctSessions = new Set(questions.flatMap(q => q.haystack));
  console.log(`record: ${questions.length} question(s), ${distinctSessions.size} distinct session(s), one isolated corpus per question.`);

  const paths = replayPaths(EMBEDDING_MODEL, "longmemeval");
  const variant = getVariant("baseline");
  const live = makeLocalAi();
  let totalMissing = 0;
  const started = performance.now();
  for (let i = 0; i < questions.length; i++) {
    const result = await prepare({
      spec: questionCorpus(questions[i], sessions), variant, backend: "sqlite", model: EMBEDDING_MODEL,
      store: new ReplayStore(paths.read, paths.write), live,
      maxNeurons: o.maxNeurons, concurrency: o.concurrency, log: () => {},
    });
    totalMissing += result.missing;
    console.log(`  [${i + 1}/${questions.length}] ${questions[i].id}: ${result.missing} new, ${result.spentNeurons.toFixed(1)} neurons.`);
  }
  const wallMs = performance.now() - started;
  const perText = totalMissing > 0 ? wallMs / totalMissing : 0;
  console.log(`record pass: ${totalMissing} text(s)/call(s) newly recorded across ${questions.length} question(s) in ${(wallMs / 1000).toFixed(1)}s (${perText.toFixed(0)} ms/item average, concurrency ${o.concurrency}).`);
}

function summarize(results: QueryResult[], isSample: boolean, counts: Record<string, number> | undefined): void {
  if (isSample) {
    console.log(`\n*** SAMPLE RESULTS (n=${results.length}), NOT the full LongMemEval benchmark. Confidence intervals are wide by design at this size -- read them, not just the point estimate. ***`);
    if (counts) console.log(`stratified per question_type: ${JSON.stringify(counts)}`);
  }
  const bySubset = new Map<string, QueryResult[]>();
  for (const r of results) {
    const subset = r.tags?.find(t => t.startsWith("subset:"))?.slice("subset:".length) ?? "unknown";
    (bySubset.get(subset) ?? bySubset.set(subset, []).get(subset)!).push(r);
  }
  const report = (rows: QueryResult[], label: string) => {
    for (const k of ["recall5", "recall10"] as const) {
      const sum = rows.reduce((s, r) => s + (r.metrics[k] ?? 0), 0);
      const mean = sum / rows.length;
      const [lo, hi] = wilson(sum, rows.length);
      console.log(`  ${label} n=${rows.length} ${k}=${mean.toFixed(3)} (95% CI ${lo.toFixed(3)}-${hi.toFixed(3)})`);
    }
  };
  console.log("\noverall:");
  report(results, "overall");
  console.log("\nby LongMemEval question_type:");
  for (const [subset, rows] of [...bySubset].sort()) report(rows, subset);
  const errors = results.filter(r => r.error);
  if (errors.length) console.log(`\n${errors.length} question(s) errored, first: ${errors[0].queryId}: ${errors[0].error}`);
}

async function runScore(o: { sample?: number; stratified?: number }): Promise<void> {
  const { sessions, questions: all } = loadLongMemEvalData();
  const { questions, counts, isSample } = selectQuestions(all, o);
  const paths = replayPaths(EMBEDDING_MODEL, "longmemeval");
  const replay = makeReplayAi({ store: new ReplayStore(paths.read), mode: "replay" });
  const started = performance.now();
  const results = await scoreQuestions({
    questions, sessions, replay, embeddingModel: EMBEDDING_MODEL, backend: "sqlite",
    onProgress: (done, total) => { if (done % 25 === 0 || done === total) console.log(`scored ${done}/${total}`); },
  });
  const wallMs = performance.now() - started;
  console.log(`score pass: ${questions.length} question(s) in ${(wallMs / 1000).toFixed(1)}s (${(wallMs / questions.length).toFixed(0)} ms/question average).`);
  summarize(results, isSample, counts);
}

async function main(): Promise<void> {
  const { cmd, sample, stratified, maxNeurons, concurrency } = parseArgs(process.argv.slice(2));
  if (cmd === "record") return runRecord({ sample, stratified, maxNeurons, concurrency });
  if (cmd === "score") return runScore({ sample, stratified });
  console.error("usage: longmemeval-cli.ts <record|score> [--stratified N | --sample N] [--max-neurons N] [--concurrency N]");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
