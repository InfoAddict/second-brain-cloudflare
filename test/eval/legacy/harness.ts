/**
 * Real-SQL harness for the legacy root-quality and hidden-validation cases.
 * Seeds each case into real SQLite (FTS5 triggers included) so the keyword
 * arm runs its real SQL; Vectorize stays a per-case mock, so the dense pool is
 * the fixture's. Scored against the frozen pre-plan baseline built from the
 * same keyword pool (see `pool` in test/helpers/recall-benchmark-scoring.ts).
 */
import { vi } from "vitest";
import { DEFAULTS } from "../../../src/config";
import { FTS_READY_KV_KEY, RERANK_MODEL, RERANK_READY_KV_KEY } from "../../../src/constants";
import { resetRerankReadyMemo } from "../../../src/recall/model-reranker";
import { createHash } from "node:crypto";
import { initializeDatabase, resetDatabaseInit } from "../../../src/db/init";
import type { Env } from "../../../src/env";
import { resetFtsReadyMemo } from "../../../src/recall/fts";
import { recallEntries } from "../../../src/recall/search";
import type { RecallDiagnostics, RecallInternalOptions } from "../../../src/recall/types";
import type { CandidateFixture, RootQualityCase, RootQualitySplit } from "../../fixtures/recall-root-quality";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../../helpers/make-env";
import {
  baselineRecall,
  directTopFourRegressed,
  rawCandidates,
  type KeywordPool,
} from "../../helpers/recall-benchmark-scoring";
import { makeSqliteD1 } from "../../helpers/sqlite-d1";

const TOP_K = 5;

export const LEGACY_MODES = ["like", "fts-orderless", "fts"] as const;
export type LegacyMode = (typeof LEGACY_MODES)[number];

export interface LegacyObservation {
  id: string;
  query: string;
  split: RootQualitySplit;
  domain: RootQualityCase["domain"];
  failureShape: RootQualityCase["failureShape"];
  candidateAvailable: boolean;
  fused: boolean;
  seed: boolean;
  expanded: boolean;
  selectedRelatedIds: string[];
  outputIds: string[];
  /** Tokens the baseline pool was built from (recall's queryTokens = profile.lexicalTokens). */
  baselineTokens: string[];
  authoritative: boolean;
  baselineAuthoritative: boolean;
  directTopFourRegression: boolean;
  authorityRankRegression: boolean;
  extraAiCalls: number;
  extraVectorizeQueries: number;
  ftsUsed?: boolean;
  rerankRoute?: string;
}

export interface LegacyMetrics {
  cases: number;
  candidateAvailability: number;
  fusionSurvival: number;
  seedHits: number;
  neighborhoodReach: number;
  authoritativeAnswers: number;
  baselineAuthoritativeAnswers: number;
  improvement: number;
  /** null when no related id was selected (no denominator); gates must treat that as a failure. */
  usefulGraphPrecision: number | null;
  /** Cases whose authoritative answer ranks strictly lower than in the baseline output (absent counts as lowest). */
  authorityRankRegressions: number;
  /** Reported only: order-identity of the top four, which scores improvements as regressions. */
  directTopFourRegressions: number;
  extraAiCalls: number;
  extraVectorizeQueries: number;
}

/** Zero-based rank of the first authoritative id, Infinity when absent. */
export function authorityRank(ids: readonly string[], authoritative: ReadonlySet<string>): number {
  const at = ids.findIndex(id => authoritative.has(id));
  return at < 0 ? Infinity : at;
}

export function authorityRankRegressed(outputIds: readonly string[], baselineIds: readonly string[], authoritative: ReadonlySet<string>): boolean {
  return authorityRank(outputIds, authoritative) > authorityRank(baselineIds, authoritative);
}

interface LegacyOptions {
  idOf: (c: RootQualityCase) => string;
  pool: KeywordPool;
  /**
   * Ablation for the graph-reach condition. Under the shipped pipeline the real
   * keyword arm finds every authoritative answer these fixtures place in the
   * corpus, so the answer is itself a graph seed and expandGraph — which never
   * re-emits a seed — cannot report reaching it. Ablating the keyword arm leaves
   * the graph as the only route to those answers, which is the condition the
   * reach and precision gates were written for.
   */
  arms?: "dense-only" | "keyword-only";
  /**
   * Run with the reranker on: mode "on", the readiness latch set, and `rerankModel` answering (default: a model that
   * agrees with the heuristic order). Root quality is then measured through the reranked direct and root views that feed
   * MMR and graph-root selection.
   */
  rerank?: boolean;
  /** With `rerank`: eval-only weight/floor override, to see how root quality moves with the blend. */
  rerankTuning?: { weight?: number; floor?: number };
  /** With `rerank`: answer with the real pinned local bge-reranker-base (opt-in, slow) or any other stand-in. */
  rerankModel?: { run(model: string, input: unknown): Promise<unknown> };
}

/** A model that agrees with the heuristic order: best first, in submission order. Isolates the blend plumbing from any judgment. */
export const heuristicOrderModel = {
  async run(_model: string, input: unknown) {
    const { contexts } = input as { contexts: unknown[] };
    return { response: contexts.map((_c, id) => ({ id, score: contexts.length - id })) };
  },
};

/** A model unrelated to the heuristic order (a hash of each passage), so it reorders. Used only to check layout, never quality. */
export const scramblingModel = {
  async run(_model: string, input: unknown) {
    const { contexts } = input as { contexts: { text: string }[] };
    return { response: contexts.map((c, id) => ({ id, score: (createHash("sha256").update(c.text).digest()[0] / 255) * 10 - 5 })) };
  },
};

async function buildFixture(c: RootQualityCase, mode: LegacyMode, idOf: LegacyOptions["idOf"], rerank = false, realModel?: LegacyOptions["rerankModel"]) {
  resetDatabaseInit();
  resetFtsReadyMemo();
  const sqlite = makeSqliteD1();
  const query = vi.fn().mockResolvedValue({
    matches: c.candidates
      .filter((candidate): candidate is CandidateFixture & { denseScore: number } => candidate.denseScore !== undefined)
      .sort((a, b) => b.denseScore - a.denseScore)
      .map(candidate => ({
        id: candidate.id,
        score: candidate.denseScore,
        metadata: { parentId: candidate.id, content: candidate.vectorContent, created_at: candidate.createdAt ?? 1 },
      })),
  });
  const env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query }),
  });
  await initializeDatabase(env);
  if (rerank) {
    const embed = (env.AI.run as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (env.AI.run as ReturnType<typeof vi.fn>).mockImplementation(async (model: string, input: never) => (model === RERANK_MODEL ? (realModel ?? heuristicOrderModel).run(model, input) : (embed as unknown as (m: string, i: unknown) => unknown)(model, input)));
    await env.OAUTH_KV.put(RERANK_READY_KV_KEY, "1");
    resetRerankReadyMemo();
  }

  // Real INSERTs for every fixture row (dense-only, keyword-only, both, and
  // unlabeled authority rows), so LIKE and FTS see what production would.
  for (const candidate of c.candidates) {
    sqlite.seed({
      id: candidate.id,
      content: candidate.content,
      createdAt: candidate.createdAt ?? 1,
      tags: [...(candidate.tags ?? [])],
      source: "legacy",
    });
    if (candidate.recallCount) {
      await sqlite.db.prepare(`UPDATE entries SET recall_count = ? WHERE id = ?`)
        .bind(candidate.recallCount, candidate.id).run();
    }
  }
  for (const [index, edge] of c.edges.entries()) {
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', 1, 1)`,
    ).bind(`${idOf(c)}-edge-${index}`, edge.sourceId, edge.targetId, edge.type, edge.weight, edge.provenance).run();
  }

  if (mode !== "like") {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
  }

  // Tracked so the background recall_count write settles before the handle closes.
  const pendingWaits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pendingWaits.push(p); } } as unknown as ExecutionContext;
  const internal: RecallInternalOptions = mode === "fts-orderless" ? { keywordPreRankedOverride: false } : {};
  return { env, ctx, query, sqlite, internal, pendingWaits };
}

// The legacy benchmarks pin the pre-reranker pipeline: their mock AI cannot rank passages, and a reranker probe would count as an extra AI call.
const RERANK_ON_CONFIG = Object.freeze({ ...DEFAULTS, RERANK_MODE: "on" });
const LEGACY_CONFIG = Object.freeze({ ...DEFAULTS, RERANK_MODE: "off" });

async function runLegacyCase(c: RootQualityCase, mode: LegacyMode, opts: LegacyOptions): Promise<LegacyObservation> {
  const fixture = await buildFixture(c, mode, opts.idOf, opts.rerank, opts.rerankModel);
  const variant = opts.arms || opts.rerankTuning ? { variant: { ...(opts.arms && { arms: opts.arms }), ...(opts.rerankTuning && { rerankTuning: opts.rerankTuning }) } } : {};
  try {
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      { query: c.query, topK: TOP_K, hops: 1, synthesize: false },
      fixture.env,
      fixture.ctx,
      opts.rerank ? RERANK_ON_CONFIG : LEGACY_CONFIG,
      { diagnostics, ...fixture.internal, ...variant },
    );
    const acceptableRoots = new Set(c.acceptableRootIds);
    const authoritative = new Set(c.authoritativeIds);
    const outputIds = result.matches.map(match => match.id);
    const baseline = baselineRecall(c, result.queryTokens ?? [], TOP_K, opts.pool);
    const aiCalls = (fixture.env.AI.run as ReturnType<typeof vi.fn>).mock.calls.length;
    await Promise.all(fixture.pendingWaits);
    return {
      id: opts.idOf(c),
      query: c.query,
      split: c.split,
      domain: c.domain,
      failureShape: c.failureShape,
      candidateAvailable: rawCandidates(c).some(candidate => acceptableRoots.has(candidate.id) || authoritative.has(candidate.id)),
      fused: (diagnostics.fusedIds ?? []).some(id => acceptableRoots.has(id)),
      seed: (diagnostics.rootSelections ?? []).some(selection => acceptableRoots.has(selection.id)),
      expanded: (diagnostics.expandedIds ?? []).some(id => authoritative.has(id)),
      selectedRelatedIds: diagnostics.selectedRelatedIds ?? [],
      outputIds,
      baselineTokens: result.queryTokens ?? [],
      authoritative: outputIds.some(id => authoritative.has(id)),
      baselineAuthoritative: baseline.outputIds.some(id => authoritative.has(id)),
      directTopFourRegression: directTopFourRegressed(outputIds, baseline.directIds),
      authorityRankRegression: authorityRankRegressed(outputIds, baseline.outputIds, authoritative),
      extraAiCalls: Math.max(0, aiCalls - 1),
      extraVectorizeQueries: Math.max(0, fixture.query.mock.calls.length - 1),
      ftsUsed: diagnostics.ftsUsed,
      rerankRoute: diagnostics.rerankRoute,
    };
  } finally {
    fixture.sqlite.close();
  }
}

export function summarizeLegacy(
  observations: LegacyObservation[],
  cases: readonly RootQualityCase[],
  idOf: LegacyOptions["idOf"],
): LegacyMetrics {
  const byId = new Map(cases.map(c => [idOf(c), c]));
  const related = observations.flatMap(o => o.selectedRelatedIds.map(id => ({ o, id })));
  const useful = related.filter(({ o, id }) => byId.get(o.id)!.authoritativeIds.includes(id)).length;
  const authoritativeAnswers = observations.filter(o => o.authoritative).length;
  const baselineAuthoritativeAnswers = observations.filter(o => o.baselineAuthoritative).length;
  return {
    cases: observations.length,
    candidateAvailability: observations.filter(o => o.candidateAvailable).length,
    fusionSurvival: observations.filter(o => o.fused).length,
    seedHits: observations.filter(o => o.candidateAvailable && o.seed).length,
    neighborhoodReach: observations.filter(o => o.expanded).length,
    authoritativeAnswers,
    baselineAuthoritativeAnswers,
    improvement: authoritativeAnswers - baselineAuthoritativeAnswers,
    usefulGraphPrecision: related.length ? useful / related.length : null,
    authorityRankRegressions: observations.filter(o => o.authorityRankRegression).length,
    directTopFourRegressions: observations.filter(o => o.directTopFourRegression).length,
    extraAiCalls: observations.reduce((sum, o) => sum + o.extraAiCalls, 0),
    extraVectorizeQueries: observations.reduce((sum, o) => sum + o.extraVectorizeQueries, 0),
  };
}

export async function evaluateLegacy(
  cases: readonly RootQualityCase[],
  mode: LegacyMode,
  opts: LegacyOptions,
): Promise<{ observations: LegacyObservation[]; metrics: LegacyMetrics }> {
  const observations: LegacyObservation[] = [];
  for (const c of cases) observations.push(await runLegacyCase(c, mode, opts));
  return { observations, metrics: summarizeLegacy(observations, cases, opts.idOf) };
}
