import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  | ({ kind: "compare"; variants: [string, string]; target: QueryCategory[]; allowUnmeasuredRows: boolean } & Common)
  | ({ kind: "prepare"; variant: string; maxNeurons: number; concurrency: number } & Common)
  | ({ kind: "lock"; acceptDataChange?: string } & Common)
  | { kind: "list" };

const HASH_MODEL = "hash-smoke";

function positive(name: string, raw: string, allowZero = false): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) throw new UsageError(`--${name} must be a ${allowZero ? "non-negative" : "positive"} number, got "${raw}"`);
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
    hash: values["hash-embeddings"]!, limit: values.limit ? positive("limit", values.limit) : undefined, json: values.json,
  };
  const command = positionals[0];
  if (command === "lock") {
    if (values["accept-data-change"] !== undefined && !values["accept-data-change"].trim()) throw new UsageError("--accept-data-change needs a non-empty reason");
    return { kind: "lock", acceptDataChange: values["accept-data-change"], ...common };
  }
  if (values["accept-data-change"] !== undefined) throw new UsageError("--accept-data-change only applies to lock");
  if (command === "prepare") {
    if (!values.variant) throw new UsageError("prepare needs --variant <name>");
    return {
      kind: "prepare", variant: values.variant, maxNeurons: positive("max-neurons", values["max-neurons"]!, true),
      concurrency: positive("concurrency", values.concurrency!), ...common,
    };
  }
  if (command) throw new UsageError(`unknown command "${command}"`);
  if (values.compare) {
    const parts = values.compare.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length !== 2) throw new UsageError("--compare needs two comma-separated entries: <baseline>,<candidate>");
    const target = (values.target ?? "").split(",").filter(Boolean);
    for (const t of target) if (!(QUERY_CATEGORIES as readonly string[]).includes(t)) throw new UsageError(`--target: unknown category "${t}"`);
    return { kind: "compare", variants: [parts[0], parts[1]], target: target as QueryCategory[], allowUnmeasuredRows: values["allow-unmeasured-rows"]!, ...common };
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
      limit: { type: "string" }, target: { type: "string" }, "allow-unmeasured-rows": { type: "boolean", default: false },
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
  const { overall, byCategory, knownGaps, excludingGaps } = summarize(report.results);
  const gapKeys = Object.keys(knownGaps.byGap);
  return [
    `variant ${report.variant} | corpus ${report.corpus} | model ${report.embeddingModel} | d1 ${report.d1Backend} | ${report.isolate}`,
    ...(report.embeddingModel === HASH_MODEL ? ["  WARNING: hash embeddings are a harness smoke test; dense results are meaningless and not comparable."] : []),
    row("overall", overall),
    ...QUERY_CATEGORIES.filter(c => byCategory[c]).map(c => row(c, byCategory[c]!)),
    ...(excludingGaps ? [
      "  excluding known gaps:",
      row("overall", excludingGaps.overall),
      ...QUERY_CATEGORIES.filter(c => excludingGaps.byCategory[c]).map(c => row(c, excludingGaps.byCategory[c]!)),
      "  known gaps (already counted above):",
      ...gapKeys.map(k => row(k, knownGaps.byGap[k])),
    ] : []),
    "  cost per query (all queries):",
    `    D1 statements  ${dist(overall.d1Statements)}`,
    overall.d1RowsRead ? `    D1 rows_read   ${dist(overall.d1RowsRead, 0)}` : "    D1 rows_read: not measured (use --d1 workerd)",
    `    AI calls       mean ${overall.aiCalls.mean.toFixed(2)}   neurons mean ${overall.neurons.mean.toFixed(1)}${overall.estimatedNeuronQueries ? ` (estimated for ${overall.estimatedNeuronQueries} quer${overall.estimatedNeuronQueries === 1 ? "y" : "ies"})` : ""}`,
    `    wall ms        p50 ${overall.wallMs.p50.toFixed(0)}  p95 ${overall.wallMs.p95.toFixed(0)}  (reported, never gated)`,
    `  leaks ${overall.leaks}   errors ${overall.errors}   degraded ${overall.degraded}`,
  ].join("\n");
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
    "known gaps (outside the headline; baseline -> candidate):",
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
  return cmd.hash ? { ...report, embeddingModel: HASH_MODEL } : report;
}

function writeJson(path: string, value: unknown): void {
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
  const gate = evaluateGate(baseline, candidate, { targetCategories: targets, allowUnmeasuredRowsRead: cmd.allowUnmeasuredRows });
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
  if (cmd.limit) throw new UsageError("lock needs the full query set; drop --limit");
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
    if (cmd.kind === "prepare") return await runPrepare(cmd);
    const spec = await resolveCorpus(cmd.corpus);
    if (cmd.kind === "compare") return await runCompare(cmd, spec);
    if (cmd.kind === "lock") return await runLock(cmd, spec);
    const report = await runNamed(cmd, spec, cmd.variant);
    console.log(formatReport(report));
    if (cmd.json) writeJson(cmd.json, report);
    return 0;
  } catch (e) {
    console.error(e instanceof UsageError ? `usage: ${e.message}` : e instanceof LockRefused ? `lock refused: ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
