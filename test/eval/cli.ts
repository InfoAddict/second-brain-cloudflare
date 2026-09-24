import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULTS } from "../../src/config";
import { LLM_TAGS_ARMS, ReplayStore, makeReplayAi, type LlmTagsArm } from "./ai-replay";
import { isCoreCorpus, listCorpora, replayPaths, resolveCorpus } from "./corpora";
import { CORE_DATA_DIR, CORPUS_IDS } from "./corpus/build";
import { loadCorpus, type LoadedCorpus } from "./corpus/loader";
import type { CorpusSpec } from "./corpus/types";
import { evaluateGate, findLosers, formatGate, formatLosers, type GateResult, type Verdict } from "./gate";
import { LockRefused, applyLock } from "./lock";
import { summarize, type Summary } from "./metrics";
import { assertIgnored, isAllowedDataFile } from "./privacy";
import { makeLocalAi } from "./local-ai";
import { producerFromCache, stampCache } from "./stamp";
import { COMMITTED_LAYER_VARIANTS, dryReranker, exportCache, prepare } from "./prepare";
import { PUBLIC_CORPORA } from "./public/neutral";
import { readReport, runVariant } from "./runner";
import { QUERY_CATEGORIES, type QueryCategory, type VariantReport } from "./types";
import { excludeNeedles } from "./corpus/exclude";
import { VARIANTS, getVariant, type VariantSpec } from "./variants";

export class UsageError extends Error {}

interface Common { llmTags: LlmTagsArm; corpus: string; d1: "sqlite" | "workerd"; isolate: "warm" | "cold"; model: string; hash: boolean; limit?: number; json?: string }
export type CliCommand =
  | ({ kind: "run"; variant: string } & Common)
  | ({ kind: "compare"; variants: [string, string]; target: QueryCategory[]; targetGaps: string[]; allowUnmeasuredRows: boolean; excludeNeedles: string[] } & Common)
  | ({ kind: "prepare"; variant: string; maxNeurons: number; concurrency: number } & Common)
  | ({ kind: "lock"; acceptDataChange?: string } & Common)
  | ({ kind: "export-cache" } & Common)
  | ({ kind: "stamp-cache"; producerFrom: string; layer: "local" | "committed"; assertRecorded: boolean } & Common)
  | { kind: "list" };

const HASH_MODEL = "hash-smoke";

function positive(name: string, raw: string, opts: { allowZero?: boolean; integer?: boolean } = {}): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || (opts.allowZero ? n < 0 : n <= 0) || (opts.integer && !Number.isInteger(n))) {
    throw new UsageError(`--${name} must be a ${opts.allowZero ? "non-negative" : "positive"} ${opts.integer ? "integer" : "number"}, got "${raw}"`);
  }
  return n;
}

/**
 * A public corpus is recorded and run with the one model it was built for (PUBLIC_CORPORA), so the model defaults
 * from the corpus. Naming any other model is refused, even explicitly: replay caches and reports for a corpus
 * under a different model would be silently incomparable. Core corpora default to the shipped model and accept any.
 */
function resolveModel(corpus: string, explicit: string | undefined): string {
  const pub = Object.hasOwn(PUBLIC_CORPORA, corpus) ? PUBLIC_CORPORA[corpus] : undefined;
  if (!pub) return explicit ?? DEFAULTS.EMBEDDING_MODEL;
  if (explicit !== undefined && explicit !== pub.embeddingModel) {
    throw new UsageError(`${corpus} must run with ${pub.embeddingModel} (its recorded embedding model); --embedding-model ${explicit} is refused`);
  }
  return pub.embeddingModel;
}

export function parseCli(argv: string[]): CliCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const { values, positionals } = parsed;
  if (values.list) return { kind: "list" };
  if (values.d1 !== "sqlite" && values.d1 !== "workerd") throw new UsageError(`--d1 must be sqlite or workerd, got ${values.d1}`);
  if (values.isolate !== "warm" && values.isolate !== "cold") throw new UsageError(`--isolate must be warm or cold, got ${values.isolate}`);
  if (!(LLM_TAGS_ARMS as readonly string[]).includes(values["llm-tags"]!)) throw new UsageError(`--llm-tags must be ${LLM_TAGS_ARMS.join(" or ")}, got ${values["llm-tags"]}`);
  const common: Common = {
    llmTags: values["llm-tags"] as LlmTagsArm, corpus: values.corpus!, d1: values.d1, isolate: values.isolate, model: resolveModel(values.corpus!, values.model ?? values["embedding-model"]),
    hash: values["hash-embeddings"]!, limit: values.limit !== undefined ? positive("limit", values.limit, { integer: true }) : undefined, json: values.json,
  };
  const command = positionals[0];
  if (command === "lock" || command === "prepare" || command === "export-cache" || command === "stamp-cache") {
    // None of these produces a report file, and all need the full query set.
    if (common.limit !== undefined) throw new UsageError(`${command} needs the full query set; --limit does not apply`);
    if (common.json !== undefined) throw new UsageError(`${command} does not write a report; --json does not apply`);
  }
  if (command === "lock") {
    if (values["accept-data-change"] !== undefined && !values["accept-data-change"].trim()) throw new UsageError("--accept-data-change needs a non-empty reason");
    return { kind: "lock", acceptDataChange: values["accept-data-change"], ...common };
  }
  if (values["accept-data-change"] !== undefined) throw new UsageError("--accept-data-change only applies to lock");
  if (command === "prepare") {
    if (!values.variant) throw new UsageError("prepare needs --variant <name>");
    return {
      kind: "prepare", variant: values.variant, maxNeurons: positive("max-neurons", values["max-neurons"]!, { allowZero: true }),
      concurrency: positive("concurrency", values.concurrency!), ...common,
    };
  }
  if (command === "stamp-cache") {
    if (!values["producer-from"]) throw new UsageError("stamp-cache needs --producer-from current|<cache file>");
    if (values.layer !== "local" && values.layer !== "committed") throw new UsageError(`--layer must be local or committed, got ${values.layer}`);
    if (values.layer === "committed" && !isCoreCorpus(common.corpus)) throw new UsageError("only core corpora have a committed layer");
    return { kind: "stamp-cache", producerFrom: values["producer-from"], layer: values.layer, assertRecorded: values["i-recorded-this"]!, ...common };
  }
  if (command === "export-cache") {
    if (common.corpus !== "core-1k") throw new UsageError("only the core-1k cache is committed; larger caches stay local in .eval-cache/");
    return { kind: "export-cache", ...common };
  }
  if (command) throw new UsageError(`unknown command "${command}"`);
  if (values.compare) {
    const parts = values.compare.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length !== 2) throw new UsageError("--compare needs two comma-separated entries: <baseline>,<candidate>");
    const target = (values.target ?? "").split(",").filter(Boolean);
    for (const t of target) if (!(QUERY_CATEGORIES as readonly string[]).includes(t)) throw new UsageError(`--target: unknown category "${t}"`);
    const targetGaps = (values["target-gaps"] ?? "").split(",").map(x => x.trim()).filter(Boolean);
    const excludeNeedles = (values["exclude-needles"] ?? "").split(",").map(x => x.trim()).filter(Boolean);
    if (excludeNeedles.some(pattern => /[^\w*.-]/.test(pattern))) throw new UsageError("--exclude-needles takes comma-separated id globs such as n-lcoh-* (letters, digits, - _ . and *)");
    return { kind: "compare", variants: [parts[0], parts[1]], target: target as QueryCategory[], targetGaps, allowUnmeasuredRows: values["allow-unmeasured-rows"]!, excludeNeedles, ...common };
  }
  if (values.variant) return { kind: "run", variant: values.variant, ...common };
  throw new UsageError("nothing to do: pass --variant, --compare, prepare, lock, export-cache, stamp-cache, or --list");
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      variant: { type: "string" }, compare: { type: "string" }, corpus: { type: "string", default: "core-1k" },
      json: { type: "string" }, d1: { type: "string", default: "sqlite" }, isolate: { type: "string", default: "warm" },
      "embedding-model": { type: "string" }, "llm-tags": { type: "string", default: "stand-in" }, model: { type: "string" }, "producer-from": { type: "string" }, layer: { type: "string", default: "local" }, "i-recorded-this": { type: "boolean", default: false }, "hash-embeddings": { type: "boolean", default: false },
      limit: { type: "string" }, target: { type: "string" }, "exclude-needles": { type: "string" }, "target-gaps": { type: "string" }, "allow-unmeasured-rows": { type: "boolean", default: false },
      "max-neurons": { type: "string", default: "4000" }, concurrency: { type: "string", default: "8" }, list: { type: "boolean", default: false }, "accept-data-change": { type: "string" },
    },
  });
}

export const exitCodeFor = (verdict: Verdict): 0 | 1 | 3 => (verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 3);

const f = (n: number) => n.toFixed(3);
const dist = (d: { mean: number; p50: number; p95: number }, digits = 1) => `mean ${d.mean.toFixed(digits)}  p50 ${d.p50.toFixed(digits)}  p95 ${d.p95.toFixed(digits)}`;
const metricsLine = (s: Summary) => `recall@5 ${f(s.metrics.recall5)}  recall@10 ${f(s.metrics.recall10)}  MRR@10 ${f(s.metrics.mrr10)}  nDCG@10 ${f(s.metrics.ndcg10)}`;
const row = (name: string, s: Summary) => `  ${name.padEnd(14)} n=${String(s.n).padEnd(4)} ${metricsLine(s)}`;

/** Why rows_read is absent: an unmeasured backend, or a workerd run where some statements reported none. */
function rowsReadMissing(report: VariantReport): string {
  if (report.d1Backend !== "workerd") return "    D1 rows_read: not measured (use --d1 workerd)";
  const missing = report.results.filter(r => r.cost.d1RowsRead === null).length;
  return `    D1 rows_read: ${missing} of ${report.results.length} queries reported no rows_read on the workerd backend, so the figure is withheld`;
}

export function formatReport(report: VariantReport): string {
  const { overall, byCategory, knownGaps, allQueries } = summarize(report.results);
  // AI calls beyond the embeddings: the LLM arm answered something (a reranking variant also counts, which only prints the caveat)
  const llmCalled = report.results.some(r => r.cost.aiCalls > r.cost.embeddingCalls);
  const gapKeys = Object.keys(knownGaps.byGap);
  return [
    `variant ${report.variant} | corpus ${report.corpus} | model ${report.embeddingModel} | d1 ${report.d1Backend} | ${report.isolate}${report.limit ? ` | LIMITED to ${report.limit} queries` : ""}`,
    ...(report.embeddingModel === HASH_MODEL ? ["  WARNING: hash embeddings are a harness smoke test; dense results are meaningless and not comparable."] : []),
    ...(gapKeys.length ? ["  (known-gap queries are excluded from the headline, as the gate excludes them; see below)"] : []),
    row("overall", overall),
    ...QUERY_CATEGORIES.filter(c => byCategory[c]).map(c => row(c, byCategory[c]!)),
    ...(overall.pool ? [
      "  candidate pool (diagnostic, not gated): share of queries with a gold anywhere in the fused pool, and recall@30; recall@30 minus recall@10 is a reranker's headroom",
      ...["overall", ...QUERY_CATEGORIES.filter(c => byCategory[c])].map(name => {
        const s = name === "overall" ? overall : byCategory[name as QueryCategory]!;
        return `    ${name.padEnd(14)} gold in pool ${f(s.pool?.goldInPool ?? 0)}  recall@30 ${f(s.pool?.recall30 ?? 0)}  headroom ${f((s.pool?.recall30 ?? 0) - s.metrics.recall10)}${name === "multi-hop" ? "  (not reranker headroom: the answer arrives by graph expansion, and recall counts the root too)" : ""}`;
      }),
    ] : []),
    ...(gapKeys.length ? [
      "  known gaps:",
      ...gapKeys.map(k => row(k, knownGaps.byGap[k])),
      row("all queries", allQueries),
    ] : []),
    "  cost per query (all queries):",
    `    D1 statements  ${dist(allQueries.d1Statements)}`,
    allQueries.d1RowsRead ? `    D1 rows_read   ${dist(allQueries.d1RowsRead, 0)}` : rowsReadMissing(report),
    "    caveat: recall@5 and MRR are read from the top-10 prefix; recall ranks from a fixed pool, so production's topK 5 is the first 5 of it",
    ...(report.llmTags ? [`    llm tags       ${report.llmTags}${llmCalled ? (report.llmTags === "stand-in" ? " (embedding-nearest stand-in for the tag-inference LLM call)" : " (empty answer: no query tags, as if the LLM call failed)") : " (inert: no LLM call was made)"}`] : []),
    ...(report.llmTags === "stand-in" && llmCalled ? ["    caveat: agreement with the real model is unmeasured"] : []),
    ...(report.llmTags ? ["    caveat: cost excludes synthesizeInsight (GET /recall's default; off in MCP and in the eval)"] : []),
    ...(report.neuronSource ? [`    neurons source ${report.neuronSource === "projected" ? "projected from local token counts x published rates (not billed)" : "provider-reported usage"}`] : []),
    `    AI calls       mean ${allQueries.aiCalls.mean.toFixed(2)}   neurons mean ${allQueries.neurons.mean.toFixed(1)}${allQueries.estimatedNeuronQueries ? ` (estimated for ${allQueries.estimatedNeuronQueries} quer${allQueries.estimatedNeuronQueries === 1 ? "y" : "ies"})` : ""}`,
    `    wall ms        p50 ${allQueries.wallMs.p50.toFixed(0)}  p95 ${allQueries.wallMs.p95.toFixed(0)}  (reported, never gated)`,
    `  leaks ${allQueries.leaks}   errors ${allQueries.errors}   degraded ${allQueries.degraded}`,
  ].join("\n");
}

/** What makes a run untrustworthy, over ALL queries (known gaps included). Empty means healthy. */
export function runProblems(report: VariantReport): string[] {
  const { errors, leaks, degraded } = summarize(report.results).allQueries;
  return [
    ...(errors ? [`${errors} query error(s)`] : []),
    ...(leaks ? [`${leaks} cross-workspace leak(s)`] : []),
    ...(degraded ? [`${degraded} degraded query(ies)`] : []),
  ];
}

/** Follows symlinks (including dangling ones) to where a write would really land. */
function realTarget(path: string, hops = 0): string {
  if (hops > 20) throw new UsageError(`too many symlinks resolving ${path}`);
  const abs = resolve(path);
  let stat;
  try { stat = lstatSync(abs); } catch { stat = undefined; }
  if (stat?.isSymbolicLink()) return realTarget(resolve(dirname(abs), readlinkSync(abs)), hops + 1);
  if (stat) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(realTarget(parent, hops + 1), basename(abs));
}

/**
 * Every CLI write except lock's allowlisted baseline goes through this: git must ignore the path and not track it
 * (privacy.assertIgnored); paths outside the repo cannot be committed and pass. Symlinks, dangling ones included,
 * are followed first. Refusals are usage errors.
 */
export function guardWrite(path: string): void {
  try { assertIgnored(realTarget(path)); } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * --json is for scratch reports. test/eval/data holds the committed golden data and baselines, and only lock writes
 * there; that gets its own message. Everything else must satisfy guardWrite. One check fails first, with one error.
 */
export function assertJsonPathAllowed(path: string): void {
  let data: string;
  try { data = realpathSync(resolve(CORE_DATA_DIR, "..")); } catch {
    throw new UsageError(`the eval data directory ${resolve(CORE_DATA_DIR, "..")} does not exist; check SB_EVAL_ROOT points at a checkout`);
  }
  const rel = relative(data, realTarget(path));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new UsageError(`--json ${path} resolves inside test/eval/data, which holds the committed golden data and baselines; only lock writes there. Write reports elsewhere (for example .eval-cache/).`);
  }
  guardWrite(path);
}

/** Which rules decided the verdict, so a FAIL is never opaque. */
export function describeVerdict(gate: GateResult): string {
  const named = (status: string) => gate.rules.filter(r => r.status === status).map(r => r.rule);
  if (gate.verdict === "PASS") return "PASS";
  if (gate.verdict === "FAIL") {
    const failed = named("fail");
    return failed.length === 1 && failed[0] === "improvement"
      ? "FAIL (improvement only; no regression, no hard-invariant or cost failure)"
      : `FAIL (failed: ${failed.join(", ")})`;
  }
  // Say why, not just which rule: an unmeasured-rows_read verdict is the one nobody can act on without the fix.
  const why = gate.rules.filter(r => r.status === "inconclusive").map(r => `${r.rule}: ${r.detail}`);
  return `INCONCLUSIVE (${why.join("; ")})`;
}

/** Side-by-side known-gap groups; empty when neither report has any. */
export function formatKnownGapDelta(base: VariantReport, cand: VariantReport): string {
  const b = summarize(base.results).knownGaps.byGap;
  const c = summarize(cand.results).knownGaps.byGap;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(c)])].sort();
  if (!keys.length) return "";
  const pair = (x: number | undefined, y: number | undefined) => `${x === undefined ? "  n/a" : f(x)} -> ${y === undefined ? "  n/a" : f(y)}`;
  return [
    "known gaps (excluded from the headline; baseline -> candidate):",
    ...keys.map(k => `  ${k.padEnd(14)} n=${String((c[k] ?? b[k]).n).padEnd(4)} recall@5 ${pair(b[k]?.metrics.recall5, c[k]?.metrics.recall5)}  recall@10 ${pair(b[k]?.metrics.recall10, c[k]?.metrics.recall10)}  MRR@10 ${pair(b[k]?.metrics.mrr10, c[k]?.metrics.mrr10)}`),
  ].join("\n");
}

async function withCorpus<T>(cmd: Common, spec: CorpusSpec, variant: VariantSpec, fn: (c: LoadedCorpus) => Promise<T>): Promise<T> {
  const paths = replayPaths(cmd.model, cmd.corpus);
  // Hash smoke: an empty in-memory store, so no recorded vector is mixed in and nothing is read from disk.
  const replay = cmd.hash
    ? makeReplayAi({ store: new ReplayStore([]), mode: "dry", llmTags: cmd.llmTags, dryOther: dryReranker }) // the smoke has no cached reranker answers either
    : makeReplayAi({ store: new ReplayStore(paths.read), mode: "replay", llmTags: cmd.llmTags });
  const corpus = await loadCorpus({ spec, backend: cmd.d1, replay, embeddingModel: cmd.model, index: variant.index });
  try { return await fn(corpus); } finally { await corpus.close(); }
}

async function runNamed(cmd: Common, spec: CorpusSpec, name: string): Promise<VariantReport> {
  if (name.endsWith(".json")) return readReport(name);
  const variant = getVariant(name);
  const queries = cmd.limit ? spec.queries.slice(0, cmd.limit) : spec.queries;
  const report = await withCorpus(cmd, spec, variant, corpus => runVariant({ corpus, variant, queries, isolate: cmd.isolate, embeddingModel: cmd.model }));
  return { ...report, ...(cmd.hash && { embeddingModel: HASH_MODEL, producers: undefined, neuronSource: undefined }), ...(cmd.limit && { limit: cmd.limit }) };
}

function writeJson(path: string, value: unknown): void {
  assertJsonPathAllowed(path);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
}

async function runPrepare(cmd: CliCommand & { kind: "prepare" }): Promise<number> {
  if (cmd.hash) throw new UsageError("prepare records real embeddings; --hash-embeddings does not apply");
  const spec = await resolveCorpus(cmd.corpus);
  const paths = replayPaths(cmd.model, cmd.corpus);
  guardWrite(paths.write); // the cache is the one thing prepare writes
  const variant = getVariant(cmd.variant);
  const live = makeLocalAi();
  await prepare({
    spec, variant, backend: cmd.d1, model: cmd.model,
    store: new ReplayStore(paths.read, paths.write), live,
    llmTags: cmd.llmTags, maxNeurons: cmd.maxNeurons, concurrency: cmd.concurrency, log: line => console.log(line),
  });
  const cut = live.truncations?.[cmd.model] ?? 0;
  console.log(`inputs cut at the model's token limit while recording: ${cut}`);
  // A contextual input must never rely on the embedder dropping its tail.
  if (cut > 0 && variant.config?.CONTEXTUAL_EMBEDDINGS === "on") {
    console.error(`prepare FAILED: ${cut} contextual input(s) exceeded the token limit; the recorded vectors would not cover their whole chunk`);
    return 1;
  }
  return 0;
}

/**
 * Report only: reruns both variants on the corpus as if the matching needles had never been written and prints each
 * category's delta there, next to the full-corpus gate above. It answers "how much of this gain is the presence of those
 * notes" (a family of long notes that crowds a dense top ten, for instance). No rule reads it.
 */
async function runWithoutNeedles(cmd: CliCommand & { kind: "compare" }, spec: CorpusSpec): Promise<{ text: string; json: unknown }> {
  if (cmd.variants.some(name => name.endsWith(".json"))) throw new UsageError("--exclude-needles reruns the variants on a reduced corpus, so it cannot take a saved report");
  const reduced = excludeNeedles(spec, cmd.excludeNeedles);
  const base = await runNamed(cmd, reduced.spec, cmd.variants[0]);
  const cand = await runNamed(cmd, reduced.spec, cmd.variants[1]);
  const gate = evaluateGate(base, cand, { allowUnmeasuredRowsRead: true });
  const rows = ["overall", ...QUERY_CATEGORIES].flatMap(scope => (["recall10", "mrr10"] as const).flatMap(metric => {
    const d = gate.deltas.find(x => x.scope === scope && x.metric === metric);
    return d ? [`    ${scope.padEnd(14)} ${metric.padEnd(9)} ${f(d.base)} -> ${f(d.candidate)}  ${d.ci.mean >= 0 ? "+" : ""}${d.ci.mean.toFixed(4)}  [${d.ci.lo.toFixed(4)}, ${d.ci.hi.toFixed(4)}]`] : [];
  }));
  const text = [
    `WITHOUT ${cmd.excludeNeedles.join(", ")} (report only, no rule reads it): ${reduced.removedEntries} entries and ${reduced.removedQueries} queries removed; deltas (candidate - baseline, 95% bootstrap CI):`,
    ...rows,
  ].join("\n");
  return { text, json: { patterns: cmd.excludeNeedles, removedEntries: reduced.removedEntries, removedQueries: reduced.removedQueries, deltas: gate.deltas } };
}

async function runCompare(cmd: CliCommand & { kind: "compare" }, spec: CorpusSpec): Promise<number> {
  const baseline = await runNamed(cmd, spec, cmd.variants[0]);
  const candidate = await runNamed(cmd, spec, cmd.variants[1]);
  console.log(`${formatReport(baseline)}\n\n${formatReport(candidate)}\n`);
  const gaps = formatKnownGapDelta(baseline, candidate);
  if (gaps) console.log(`${gaps}\n`);
  // getVariant resolves parametric names (rerank:w100k30e400) that the registry does not list; a report file may name any variant
  const declared = (() => { try { return getVariant(candidate.variant); } catch { return undefined; } })();
  const targets = cmd.target.length ? cmd.target : [...(declared?.targetCategories ?? [])];
  const targetGaps = cmd.targetGaps.length ? cmd.targetGaps : [...(declared?.targetGaps ?? [])];
  const gate = evaluateGate(baseline, candidate, { targetCategories: targets, targetGaps, allowUnmeasuredRowsRead: cmd.allowUnmeasuredRows });
  console.log(`${describeVerdict(gate)}\n${formatGate(gate)}`);
  const without = cmd.excludeNeedles.length ? await runWithoutNeedles(cmd, spec) : undefined;
  if (without) console.log(`\n${without.text}`);
  // Per-query view of what the means can hide; printed after the verdict and never part of it.
  const losers = formatLosers(findLosers(baseline, candidate));
  if (losers) console.log(`\n${losers}`);
  if (cmd.json) writeJson(cmd.json, { baseline, candidate, gate, ...(without && { withoutNeedles: without.json }) });
  // Hash vectors carry no semantics, so a smoke comparison must never read as a ship signal.
  if (gate.verdict === "PASS" && [baseline, candidate].some(r => r.embeddingModel === HASH_MODEL)) {
    console.log("NOTE: hash-embedding comparison is a smoke test and cannot PASS; reporting INCONCLUSIVE.");
    return exitCodeFor("INCONCLUSIVE");
  }
  return exitCodeFor(gate.verdict);
}

/** Writes the committed core replay layer from the recorded cache; like lock, it may write only its allowlisted file. */
async function runExportCache(cmd: CliCommand & { kind: "export-cache" }, spec: CorpusSpec): Promise<number> {
  if (cmd.hash) throw new UsageError("export-cache exports recorded embeddings; --hash-embeddings does not apply");
  const out = resolve(CORE_DATA_DIR, `replay.${cmd.model.split("/").pop()}.jsonl.gz`);
  if (!isAllowedDataFile(`test/eval/data/core/${basename(out)}`)) throw new UsageError(`${basename(out)} is not an allowlisted replay file name`);
  // read already lists only files that exist and already includes the local write cache
  const { read } = replayPaths(cmd.model, cmd.corpus);
  const n = await exportCache({ spec, variant: COMMITTED_LAYER_VARIANTS.map(name => getVariant(name)), backend: cmd.d1, model: cmd.model, readPaths: read, outPath: out, llmTags: "stand-in" });
  console.log(`exported ${n} cache entries to ${out}`);
  return 0;
}

/** Stamps legacy rows of a cache you recorded yourself with its producer; a human assertion, never a check (see stamp.ts). */
function runStampCache(cmd: CliCommand & { kind: "stamp-cache" }): number {
  if (!cmd.assertRecorded) {
    throw new UsageError("stamp-cache asserts, on your word, that YOU recorded every unlabeled row in the file with this producer: legacy rows store only a hash of (model, input), so the claim cannot be verified. Pass --i-recorded-this to make it");
  }
  const file = cmd.layer === "committed" ? resolve(CORE_DATA_DIR, `replay.${cmd.model.split("/").pop()}.jsonl.gz`) : replayPaths(cmd.model, cmd.corpus).write;
  if (!existsSync(file)) throw new UsageError(`${file} does not exist`);
  const producer = cmd.producerFrom === "current" ? makeLocalAi().producer(cmd.model) : producerFromCache(resolve(cmd.producerFrom), cmd.model);
  const { stamped, already } = stampCache({ file, model: cmd.model, producer });
  console.log(`stamped ${stamped} legacy row(s) in ${file} as ${cmd.model} / ${producer.repo}@${producer.revision.slice(0, 12)} (${producer.library} ${producer.libraryVersion}) on the operator's assertion --i-recorded-this; ${already} row(s) were already stamped. The rows could not be verified: inputs are not stored, so keys cannot be recomputed.`);
  return 0;
}

/** Rerun the baseline and refresh the committed lock; changed golden data needs --accept-data-change. */
function checkLockable(cmd: CliCommand & { kind: "lock" }): void {
  if (cmd.hash) throw new UsageError("lock records real rankings; --hash-embeddings does not apply");
  if (!isCoreCorpus(cmd.corpus)) throw new UsageError(`public corpora are local-only and never locked; lock covers the core corpora only (${CORPUS_IDS.join(", ")})`);
}

async function runLock(cmd: CliCommand & { kind: "lock" }, spec: CorpusSpec): Promise<number> {
  checkLockable(cmd);
  const lockPath = resolve(CORE_DATA_DIR, "../baselines", `${cmd.corpus}.${cmd.model.split("/").pop()}.json`);
  // lock is the one writer allowed under test/eval/data, and only to files the privacy allowlist names
  if (!isAllowedDataFile(`test/eval/data/baselines/${basename(lockPath)}`)) throw new UsageError(`${basename(lockPath)} is not an allowlisted baseline file name`);
  const { dataChanged } = await applyLock({
    dataDir: CORE_DATA_DIR,
    lockPath,
    acceptReason: cmd.acceptDataChange,
    runBaseline: () => runNamed(cmd, spec, "baseline"),
  });
  console.log(`locked ${lockPath}${dataChanged ? " (golden data change recorded in manifest history)" : ""}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const cmd = parseCli(argv);
    if (cmd.kind === "list") {
      console.log(`variants:\n${Object.values(VARIANTS).map(v => `  ${v.name.padEnd(16)} ${v.description}`).join("\n")}\ncorpora: ${listCorpora().join(", ")}`);
      return 0;
    }
    if (cmd.json) assertJsonPathAllowed(cmd.json); // before the slow part, not after
    if (cmd.kind === "prepare") return await runPrepare(cmd);
    if (cmd.kind === "stamp-cache") return runStampCache(cmd);
    if (cmd.kind === "lock") checkLockable(cmd); // before resolveCorpus, so a public corpus is refused for the right reason
    const spec = await resolveCorpus(cmd.corpus);
    if (cmd.kind === "compare") return await runCompare(cmd, spec);
    if (cmd.kind === "lock") return await runLock(cmd, spec);
    if (cmd.kind === "export-cache") return await runExportCache(cmd, spec);
    const report = await runNamed(cmd, spec, cmd.variant);
    console.log(formatReport(report));
    if (cmd.json) writeJson(cmd.json, report);
    const problems = runProblems(report);
    if (problems.length) {
      console.error(`run FAILED: ${problems.join(", ")}${cmd.json ? "" : " (pass --json to keep the per-query detail)"}`);
      return 1;
    }
    return 0;
  } catch (e) {
    console.error(e instanceof UsageError ? `usage: ${e.message}` : e instanceof LockRefused ? `lock refused: ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
