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
import type { CostSample, GoldenQuery, QueryResult, VariantReport } from "./types";
import type { VariantSpec } from "./variants";

/** Metrics need the top 10; recall@5 is read from its first five (Decision 9). */
export const EVAL_TOP_K = 10;

/** Bump when what a report means changes (measurement, guards, degradation flags). */
export const RUNNER_VERSION = 1;

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
function withoutRecallCountWrites(db: D1Database, onIntercept: () => void): D1Database {
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
      const degradedBefore = vectorizeFilterState().degradedQueries;
      intercepted = 0;
      const started = performance.now();
      const result = await recallEntries(
        { query: q.text, topK: EVAL_TOP_K, hops: q.hops, synthesize: false },
        env, ctx, cfg,
        { ...variant.internal, identity: IDENTITIES[q.viewer], workspaceFilter: q.layer, diagnostics },
      );
      return {
        result, diagnostics, wallMs: performance.now() - started, calls: corpus.replay.drainCalls(),
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
    return { schema: 1, variant: variant.name, corpus: corpus.id, embeddingModel: o.embeddingModel, d1Backend: corpus.d1.kind, isolate: o.isolate, topK: EVAL_TOP_K, runnerVersion: RUNNER_VERSION, results };
  } finally {
    restoreClock();
  }
}

export function writeReport(path: string, report: VariantReport): void {
  writeFileSync(path, `${JSON.stringify(report, null, 1)}\n`);
}

export function readReport(path: string): VariantReport {
  const report = JSON.parse(readFileSync(path, "utf8")) as VariantReport;
  if (report.schema !== 1) throw new Error(`${path}: unsupported report schema ${report.schema}`);
  return report;
}
