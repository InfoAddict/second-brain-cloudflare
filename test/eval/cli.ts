import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULTS } from "../../src/config";
import { ReplayStore, makeReplayAi, makeRestAi } from "./ai-replay";
import { listCorpora, replayPaths, resolveCorpus } from "./corpora";
import { CORE_DATA_DIR, CORPUS_IDS } from "./corpus/build";
import { loadCorpus, type LoadedCorpus } from "./corpus/loader";
import type { CorpusSpec } from "./corpus/types";
import { evaluateGate, formatGate, type GateResult, type Verdict } from "./gate";
import { LockRefused, applyLock } from "./lock";
import { summarize, type Summary } from "./metrics";
import { prepare } from "./prepare";
import { readReport, runVariant } from "./runner";
import { QUERY_CATEGORIES, type QueryCategory, type VariantReport } from "./types";
import { VARIANTS, getVariant, type VariantSpec } from "./variants";

export class UsageError extends Error {}

interface Common { corpus: string; d1: "sqlite" | "workerd"; isolate: "warm" | "cold"; model: string; hash: boolean; limit?: number; json?: string }
export type CliCommand =
  | ({ kind: "run"; variant: string } & Common)
  | ({ kind: "compare"; variants: [string, string]; target: QueryCategory[]; targetGaps: string[]; allowUnmeasuredRows: boolean } & Common)
  | ({ kind: "prepare"; variant: string; maxNeurons: number; concurrency: number } & Common)
  | ({ kind: "lock"; acceptDataChange?: string } & Common)
  | { kind: "list" };

const HASH_MODEL = "hash-smoke";

function positive(name: string, raw: string, opts: { allowZero?: boolean; integer?: boolean } = {}): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || (opts.allowZero ? n < 0 : n <= 0) || (opts.integer && !Number.isInteger(n))) {
    throw new UsageError(`--${name} must be a ${opts.allowZero ? "non-negative" : "positive"} ${opts.integer ? "integer" : "number"}, got "${raw}"`);
  }
  return n;
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
  const common: Common = {
    corpus: values.corpus!, d1: values.d1, isolate: values.isolate, model: values["embedding-model"]!,
    hash: values["hash-embeddings"]!, limit: values.limit !== undefined ? positive("limit", values.limit, { integer: true }) : undefined, json: values.json,
  };
  const command = positionals[0];
  if (command === "lock" || command === "prepare") {
    // Neither command produces a report file, and both need the full query set.
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
  if (command) throw new UsageError(`unknown command "${command}"`);
  if (values.compare) {
    const parts = values.compare.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length !== 2) throw new UsageError("--compare needs two comma-separated entries: <baseline>,<candidate>");
    const target = (values.target ?? "").split(",").filter(Boolean);
    for (const t of target) if (!(QUERY_CATEGORIES as readonly string[]).includes(t)) throw new UsageError(`--target: unknown category "${t}"`);
    const targetGaps = (values["target-gaps"] ?? "").split(",").map(x => x.trim()).filter(Boolean);
    return { kind: "compare", variants: [parts[0], parts[1]], target: target as QueryCategory[], targetGaps, allowUnmeasuredRows: values["allow-unmeasured-rows"]!, ...common };
  }
  if (values.variant) return { kind: "run", variant: values.variant, ...common };
  throw new UsageError("nothing to do: pass --variant, --compare, prepare, lock, or --list");
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      variant: { type: "string" }, compare: { type: "string" }, corpus: { type: "string", default: "core-1k" },
      json: { type: "string" }, d1: { type: "string", default: "sqlite" }, isolate: { type: "string", default: "warm" },
      "embedding-model": { type: "string", default: DEFAULTS.EMBEDDING_MODEL }, "hash-embeddings": { type: "boolean", default: false },
      limit: { type: "string" }, target: { type: "string" }, "target-gaps": { type: "string" }, "allow-unmeasured-rows": { type: "boolean", default: false },
      "max-neurons": { type: "string", default: "4000" }, concurrency: { type: "string", default: "8" }, list: { type: "boolean", default: false }, "accept-data-change": { type: "string" },
    },
  });
}

export const exitCodeFor = (verdict: Verdict): 0 | 1 | 3 => (verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 3);

const f = (n: number) => n.toFixed(3);
const dist = (d: { mean: number; p50: number; p95: number }, digits = 1) => `mean ${d.mean.toFixed(digits)}  p50 ${d.p50.toFixed(digits)}  p95 ${d.p95.toFixed(digits)}`;
const metricsLine = (s: Summary) => `recall@5 ${f(s.metrics.recall5)}  recall@10 ${f(s.metrics.recall10)}  MRR@10 ${f(s.metrics.mrr10)}  nDCG@10 ${f(s.metrics.ndcg10)}`;
const row = (name: string, s: Summary) => `  ${name.padEnd(14)} n=${String(s.n).padEnd(4)} ${metricsLine(s)}`;

export function formatReport(report: VariantReport): string {
  const { overall, byCategory, knownGaps, allQueries } = summarize(report.results);
  const gapKeys = Object.keys(knownGaps.byGap);
  return [
    `variant ${report.variant} | corpus ${report.corpus} | model ${report.embeddingModel} | d1 ${report.d1Backend} | ${report.isolate}${report.limit ? ` | LIMITED to ${report.limit} queries` : ""}`,
    ...(report.embeddingModel === HASH_MODEL ? ["  WARNING: hash embeddings are a harness smoke test; dense results are meaningless and not comparable."] : []),
    ...(gapKeys.length ? ["  (known-gap queries are excluded from the headline, as the gate excludes them; see below)"] : []),
    row("overall", overall),
    ...QUERY_CATEGORIES.filter(c => byCategory[c]).map(c => row(c, byCategory[c]!)),
    ...(gapKeys.length ? [
      "  known gaps:",
      ...gapKeys.map(k => row(k, knownGaps.byGap[k])),
      row("all queries", allQueries),
    ] : []),
    "  cost per query (all queries):",
    `    D1 statements  ${dist(allQueries.d1Statements)}`,
    allQueries.d1RowsRead ? `    D1 rows_read   ${dist(allQueries.d1RowsRead, 0)}` : "    D1 rows_read: not measured (use --d1 workerd)",
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

/** --json is for scratch reports. The committed golden data and baselines are written only by lock. */
export function assertJsonPathAllowed(path: string): void {
  const data = realpathSync(resolve(CORE_DATA_DIR, ".."));
  const rel = relative(data, realTarget(path));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new UsageError(`--json ${path} resolves inside test/eval/data, which holds the committed golden data and baselines; only lock writes there. Write reports elsewhere (for example .eval-cache/).`);
  }
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
  return `INCONCLUSIVE (${named("inconclusive").join(", ")})`;
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
  const paths = replayPaths(cmd.model);
  // Hash smoke: an empty in-memory store, so no recorded vector is mixed in and nothing is read from disk.
  const replay = cmd.hash
    ? makeReplayAi({ store: new ReplayStore([]), mode: "dry" })
    : makeReplayAi({ store: new ReplayStore(paths.read), mode: "replay" });
  const corpus = await loadCorpus({ spec, backend: cmd.d1, replay, embeddingModel: cmd.model, index: variant.index });
  try { return await fn(corpus); } finally { await corpus.close(); }
}

async function runNamed(cmd: Common, spec: CorpusSpec, name: string): Promise<VariantReport> {
  if (name.endsWith(".json")) return readReport(name);
  const variant = getVariant(name);
  const queries = cmd.limit ? spec.queries.slice(0, cmd.limit) : spec.queries;
  const report = await withCorpus(cmd, spec, variant, corpus => runVariant({ corpus, variant, queries, isolate: cmd.isolate, embeddingModel: cmd.model }));
  return { ...report, ...(cmd.hash && { embeddingModel: HASH_MODEL }), ...(cmd.limit && { limit: cmd.limit }) };
}

function writeJson(path: string, value: unknown): void {
  assertJsonPathAllowed(path);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
}

async function runPrepare(cmd: CliCommand & { kind: "prepare" }): Promise<number> {
  if (cmd.hash) throw new UsageError("prepare records real embeddings; --hash-embeddings does not apply");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID, apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new UsageError("prepare needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment (Workers AI, compute only)");
  const spec = await resolveCorpus(cmd.corpus);
  const paths = replayPaths(cmd.model);
  await prepare({
    spec, variant: getVariant(cmd.variant), backend: cmd.d1, model: cmd.model,
    store: new ReplayStore(paths.read, paths.write), live: makeRestAi({ accountId, apiToken }),
    maxNeurons: cmd.maxNeurons, concurrency: cmd.concurrency, log: line => console.log(line),
  });
  return 0;
}

async function runCompare(cmd: CliCommand & { kind: "compare" }, spec: CorpusSpec): Promise<number> {
  const baseline = await runNamed(cmd, spec, cmd.variants[0]);
  const candidate = await runNamed(cmd, spec, cmd.variants[1]);
  console.log(`${formatReport(baseline)}\n\n${formatReport(candidate)}\n`);
  const gaps = formatKnownGapDelta(baseline, candidate);
  if (gaps) console.log(`${gaps}\n`);
  const targets = cmd.target.length ? cmd.target : [...(VARIANTS[candidate.variant]?.targetCategories ?? [])];
  const targetGaps = cmd.targetGaps.length ? cmd.targetGaps : [...(VARIANTS[candidate.variant]?.targetGaps ?? [])];
  const gate = evaluateGate(baseline, candidate, { targetCategories: targets, targetGaps, allowUnmeasuredRowsRead: cmd.allowUnmeasuredRows });
  console.log(`${describeVerdict(gate)}\n${formatGate(gate)}`);
  if (cmd.json) writeJson(cmd.json, { baseline, candidate, gate });
  // Hash vectors carry no semantics, so a smoke comparison must never read as a ship signal.
  if (gate.verdict === "PASS" && [baseline, candidate].some(r => r.embeddingModel === HASH_MODEL)) {
    console.log("NOTE: hash-embedding comparison is a smoke test and cannot PASS; reporting INCONCLUSIVE.");
    return exitCodeFor("INCONCLUSIVE");
  }
  return exitCodeFor(gate.verdict);
}

/** Rerun the baseline and refresh the committed lock; changed golden data needs --accept-data-change. */
async function runLock(cmd: CliCommand & { kind: "lock" }, spec: CorpusSpec): Promise<number> {
  if (cmd.hash) throw new UsageError("lock records real rankings; --hash-embeddings does not apply");
  if (!(CORPUS_IDS as readonly string[]).includes(cmd.corpus)) throw new UsageError(`lock covers the core corpora only (${CORPUS_IDS.join(", ")})`);
  const { lockPath, dataChanged } = await applyLock({
    dataDir: CORE_DATA_DIR,
    lockPath: resolve(CORE_DATA_DIR, "../baselines", `${cmd.corpus}.${cmd.model.split("/").pop()}.json`),
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
    const spec = await resolveCorpus(cmd.corpus);
    if (cmd.kind === "compare") return await runCompare(cmd, spec);
    if (cmd.kind === "lock") return await runLock(cmd, spec);
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
