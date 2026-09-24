import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULTS, type Config } from "../../src/config";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { readScopeWorkspaces } from "../../src/lib/scope";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { resetVectorizeFilterState, vectorizeFilterState } from "../../src/vectorize/scope";
import type { LoadedCorpus } from "./corpus/loader";
import { EVAL_NOW, IDENTITIES } from "./corpus/types";
import { scoreQuery } from "./metrics";
import { QUERY_CATEGORIES, RUNNER_VERSION, type CostSample, type GoldenQuery, type QueryResult, type VariantReport } from "./types";
import type { VariantSpec } from "./variants";

/** Metrics need the top 10; recall@5 is read from its first five (Decision 9). */
export const EVAL_TOP_K = 10;

export { RUNNER_VERSION };

export function freezeClock(fixed: number): () => void {
  const real = Date.now;
  Date.now = () => fixed;
  return () => { Date.now = real; };
}

export function findLeaks(rankedIds: readonly string[], readable: ReadonlySet<string>, workspaceOf: ReadonlyMap<string, string>): string[] {
  return rankedIds.filter(id => !readable.has(workspaceOf.get(id) ?? "\u0000unknown"));
}

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

class RecallCountDrift extends Error {
  constructor(queryId: string) {
    super(`query ${queryId} returned results but no recall_count write was intercepted; the statement in search.ts changed, update RECALL_COUNT_BUMP`);
  }
}

const RECALL_COUNT_BUMP = /^\s*UPDATE\s+entries\s+SET\s+recall_count\s*=\s*recall_count\s*\+\s*1\b/i;

/**
 * recallEntries builds the recall_count UPDATE eagerly (search.ts), so a no-op waitUntil alone does not
 * stop it. Answer that one statement with an inert result priced like the real PK update; it stays visible to the cost counters.
 */
export function withoutRecallCountWrites(db: D1Database, onIntercept: () => void): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") {
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      }
      return (sql: string) => {
        if (!RECALL_COUNT_BUMP.test(sql)) return target.prepare(sql);
        onIntercept();
        const inert = { bind: () => inert, run: async () => ({ success: true, results: [], meta: { rows_read: 1, rows_written: 1 } }) };
        return inert as unknown as D1PreparedStatement;
      };
    },
  });
}
const ZERO_COST: CostSample = { d1Statements: 0, d1RowsRead: null, aiCalls: 0, embeddingCalls: 0, vectorizeQueries: 0, kvReads: 0, neurons: 0, neuronsEstimated: false, wallMs: 0 };

export async function runVariant(o: {
  corpus: LoadedCorpus;
  variant: VariantSpec;
  queries: readonly GoldenQuery[];
  isolate: "warm" | "cold";
  embeddingModel: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<VariantReport> {
  const { corpus, variant } = o;
  const wantedIndex = variant.index?.id ?? "shipped";
  if (corpus.indexId !== wantedIndex) {
    throw new Error(`variant ${variant.name} needs index "${wantedIndex}" but the corpus was built with "${corpus.indexId}"; load a corpus per index variant`);
  }
  const restoreClock = freezeClock(EVAL_NOW);
  try {
    const cfg: Readonly<Config> = Object.freeze({ ...DEFAULTS, EMBEDDING_MODEL: o.embeddingModel, ...variant.config });
    if (variant.ftsReady === false) await corpus.env.OAUTH_KV.delete(FTS_READY_KV_KEY);
    else await corpus.env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    resetVectorizeFilterState(); // module-level latch: every run starts from a fresh isolate

    let intercepted = 0;
    const env = { ...corpus.env, DB: withoutRecallCountWrites(corpus.env.DB, () => { intercepted++; }) } as typeof corpus.env;
    const recallOnce = async (q: GoldenQuery) => {
      const diagnostics: RecallDiagnostics = {};
      corpus.replay.drainCalls();
      corpus.replay.drainErrors(q.id);
      const degradedBefore = vectorizeFilterState().degradedQueries;
      intercepted = 0;
      const started = performance.now();
      // A swallowed side call (as the retired tag inference was) can outlive a failed recall. Scope its calls to this query and wait for them, or a late failure would be charged to the next one.
      let result: Awaited<ReturnType<typeof recallEntries>> | undefined;
      let recallError: unknown;
      try {
        result = await corpus.replay.scope(q.id, () => recallEntries(
          { query: q.text, topK: EVAL_TOP_K, hops: q.hops, synthesize: false },
          env, ctx, cfg,
          { ...variant.internal, identity: IDENTITIES[q.viewer], workspaceFilter: q.layer, diagnostics },
        ));
      } catch (e) {
        recallError = e;
      }
      await corpus.replay.settle(q.id);
      const standInFailures = corpus.replay.drainErrors(q.id);
      const standInMessage = standInFailures.length ? `query-tag stand-in failed: ${standInFailures.join("; ")}` : "";
      if (recallError) throw standInMessage ? new Error(`${recallError instanceof Error ? recallError.message : String(recallError)}; ${standInMessage}`) : recallError;
      if (standInMessage) throw new Error(standInMessage);
      return {
        result: result!, diagnostics, wallMs: performance.now() - started, calls: corpus.replay.drainCalls(),
        filterDegraded: vectorizeFilterState().degradedQueries > degradedBefore,
      };
    };

    if (o.isolate === "warm") {
      const seen = new Set<string>();
      for (const q of o.queries) {
        if (seen.has(q.viewer)) continue;
        seen.add(q.viewer);
        await recallOnce(q).catch(() => undefined); // warm-up only; a real failure is recorded on the scored pass
      }
    }

    const results: QueryResult[] = [];
    for (const q of o.queries) {
      if (o.isolate === "cold") { resetFtsReadyMemo(); resetVectorizeFilterState(); }
      const readable = new Set(readScopeWorkspaces(IDENTITIES[q.viewer], { layer: q.layer }));
      const base = { queryId: q.id, category: q.category, clusterKey: q.clusterKey ?? q.id, ...(q.tags && { tags: q.tags }) };
      try {
        const { result, diagnostics, wallMs, calls, filterDegraded } = await recallOnce(q);
        const rankedIds = result.matches.map(m => m.id);
        const ops = diagnostics.operations!;
        results.push({
          ...base,
          rankedIds,
          metrics: scoreQuery(rankedIds, q.gold),
          cost: {
            d1Statements: ops.d1Statements, d1RowsRead: ops.d1RowsRead, aiCalls: ops.aiCalls, embeddingCalls: ops.embeddingCalls,
            vectorizeQueries: ops.vectorizeQueries, kvReads: ops.kvReads, neurons: calls.reduce((s, c) => s + c.neurons, 0), neuronsEstimated: calls.some(c => c.neuronsEstimated), wallMs,
          },
          leaked: findLeaks(rankedIds, readable, corpus.workspaceOf),
          ftsRoute: diagnostics.ftsRoute,
          degraded: [
            ...(result.semanticUnavailable ? ["semantic-unavailable"] : []),
            ...(filterDegraded ? ["vectorize-filter-unfiltered"] : []),
            ...(diagnostics.ftsRoute === "like-error" ? ["fts-error"] : []),
            ...(diagnostics.warnings?.length ? ["first-returned-many-rows"] : []),
          ],
        });
        // Presented direct results always bump recall_count; none seen means the write drifted past the guard.
        if (rankedIds.length && intercepted === 0) throw new RecallCountDrift(q.id);
      } catch (e) {
        if (e instanceof RecallCountDrift) throw e;
        results.push({ ...base, rankedIds: [], metrics: scoreQuery([], q.gold), cost: ZERO_COST, leaked: [], error: e instanceof Error ? e.message : String(e) });
      }
      o.onProgress?.(results.length, o.queries.length);
    }
    const producers = corpus.replay.producers(), neuronSource = corpus.replay.neuronSource();
    return { schema: 1, variant: variant.name, corpus: corpus.id, embeddingModel: o.embeddingModel, ...(Object.keys(producers).length && { producers }), ...(neuronSource && { neuronSource }), llmTags: corpus.replay.llmTags, d1Backend: corpus.d1.kind, isolate: o.isolate, topK: EVAL_TOP_K, runnerVersion: RUNNER_VERSION, ...(corpus.dataFingerprint && { dataFingerprint: corpus.dataFingerprint }), results };
  } finally {
    restoreClock();
  }
}

export function writeReport(path: string, report: VariantReport): void {
  writeFileSync(path, `${JSON.stringify(report, null, 1)}\n`);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** Throws naming the first field a report gets wrong; the gate reads all of these without checking. */
function validateReport(raw: unknown, path: string): VariantReport {
  const fail = (field: string, want: string): never => { throw new Error(`${path}: report field ${field} must be ${want}`); };
  if (!raw || typeof raw !== "object") return fail("(root)", "an object");
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1) throw new Error(`${path}: unsupported report schema ${String(r.schema)}`);
  for (const f of ["variant", "corpus", "embeddingModel"]) if (!isStr(r[f])) fail(f, "a string");
  if (r.producers !== undefined) {
    const m = r.producers as Record<string, Record<string, unknown> | null> | null;
    if (!m || typeof m !== "object" || Array.isArray(m)) fail("producers", "a map of producer records");
    for (const [model, p] of Object.entries(m!)) {
      if (!p || typeof p !== "object" || !["kind", "library", "libraryVersion", "onnxRuntime", "repo", "revision", "dtype"].every(k => isStr(p[k]))) fail(`producers[${model}]`, "a producer record");
    }
  }
  if (r.neuronSource !== undefined && r.neuronSource !== "projected" && r.neuronSource !== "provider") fail("neuronSource", "projected or provider");
  if (r.llmTags !== undefined && r.llmTags !== "stand-in" && r.llmTags !== "empty") fail("llmTags", "stand-in or empty");
  if (r.d1Backend !== "sqlite" && r.d1Backend !== "workerd") fail("d1Backend", "sqlite or workerd");
  if (r.isolate !== "warm" && r.isolate !== "cold") fail("isolate", "warm or cold");
  if (!isNum(r.topK)) fail("topK", "a number");
  if (!isNum(r.runnerVersion)) fail("runnerVersion", "a number");
  if (r.limit !== undefined && !(Number.isInteger(r.limit) && (r.limit as number) > 0)) fail("limit", "a positive integer");
  if (r.dataFingerprint !== undefined && !(r.dataFingerprint && typeof r.dataFingerprint === "object" && !Array.isArray(r.dataFingerprint) && Object.values(r.dataFingerprint).every(isStr))) fail("dataFingerprint", "an object of hashes");
  if (!Array.isArray(r.results)) return fail("results", "an array");
  (r.results as unknown[]).forEach((x, i) => {
    const q = (x ?? {}) as Record<string, unknown>;
    const at = (f: string) => `results[${i}].${f}`;
    if (!isStr(q.queryId)) fail(at("queryId"), "a string");
    if (!(QUERY_CATEGORIES as readonly string[]).includes(q.category as string)) fail(at("category"), "a known category");
    if (!isStr(q.clusterKey)) fail(at("clusterKey"), "a string");
    if (!isStrArray(q.rankedIds)) fail(at("rankedIds"), "a string array");
    if (!isStrArray(q.leaked)) fail(at("leaked"), "a string array");
    if (q.tags !== undefined && !isStrArray(q.tags)) fail(at("tags"), "a string array");
    if (q.degraded !== undefined && !isStrArray(q.degraded)) fail(at("degraded"), "a string array");
    const m = q.metrics as Record<string, unknown> | undefined;
    if (!m || !["recall5", "recall10", "mrr10", "ndcg10"].every(k => isNum(m[k]))) fail(at("metrics"), "four numbers");
    const c = q.cost as Record<string, unknown> | undefined;
    if (!c || !["d1Statements", "aiCalls", "embeddingCalls", "vectorizeQueries", "kvReads", "neurons", "wallMs"].every(k => isNum(c[k]))
      || !(c.d1RowsRead === null || isNum(c.d1RowsRead)) || typeof c.neuronsEstimated !== "boolean") fail(at("cost"), "a full cost sample");
  });
  return raw as VariantReport;
}

export function readReport(path: string): VariantReport {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new Error(`${path}: not valid JSON (${(e as Error).message})`); }
  return validateReport(raw, path);
}
