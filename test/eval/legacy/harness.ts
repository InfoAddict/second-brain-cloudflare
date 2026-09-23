/**
 * Real-SQL harness for the legacy root-quality and hidden-validation cases.
 * Seeds each case into real SQLite (FTS5 triggers included) so the keyword
 * arm runs its real SQL; Vectorize stays a per-case mock, so the dense pool is
 * the fixture's. Scored against the frozen pre-plan baseline built from the
 * same keyword pool (see `pool` in test/helpers/recall-benchmark-scoring.ts).
 */
import { vi } from "vitest";
import { FTS_READY_KV_KEY } from "../../../src/constants";
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
  authoritative: boolean;
  baselineAuthoritative: boolean;
  directTopFourRegression: boolean;
  extraAiCalls: number;
  extraVectorizeQueries: number;
  ftsUsed?: boolean;
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
  usefulGraphPrecision: number;
  directTopFourRegressions: number;
  extraAiCalls: number;
  extraVectorizeQueries: number;
}

interface LegacyOptions {
  idOf: (c: RootQualityCase) => string;
  pool: KeywordPool;
}

async function buildFixture(c: RootQualityCase, mode: LegacyMode, idOf: LegacyOptions["idOf"]) {
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

async function runLegacyCase(c: RootQualityCase, mode: LegacyMode, opts: LegacyOptions): Promise<LegacyObservation> {
  const fixture = await buildFixture(c, mode, opts.idOf);
  try {
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      { query: c.query, topK: TOP_K, hops: 1, synthesize: false },
      fixture.env,
      fixture.ctx,
      undefined,
      { diagnostics, ...fixture.internal },
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
      authoritative: outputIds.some(id => authoritative.has(id)),
      baselineAuthoritative: baseline.outputIds.some(id => authoritative.has(id)),
      directTopFourRegression: directTopFourRegressed(outputIds, baseline.directIds),
      extraAiCalls: Math.max(0, aiCalls - 1),
      extraVectorizeQueries: Math.max(0, fixture.query.mock.calls.length - 1),
      ftsUsed: diagnostics.ftsUsed,
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
    usefulGraphPrecision: related.length ? useful / related.length : 1,
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
