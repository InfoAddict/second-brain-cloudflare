/**
 * Task 7 (#374 FTS5 lexical arm): real-SQLite port of
 * recall-root-quality-hidden-validation.test.ts.
 *
 * See recall-root-quality-benchmark.sqlite.test.ts for the full rationale:
 * the mock-based original's keyword arm is a canned string match, blind to
 * LIKE vs FTS. This file seeds the same sealed HIDDEN_VALIDATION_CASES into
 * real SQLite (node:sqlite, FTS5 trigram) and runs keywordSearch for real in
 * three modes (like / fts-orderless / fts). Same cases, same scoring helpers
 * (test/helpers/recall-benchmark-scoring.ts) as the original.
 *
 * Per the task brief this port, unlike the root-quality port, must ALSO meet
 * the original's frozen ship gates in every mode — these are not loosened if
 * they fail; a failure here is the finding this file exists to surface.
 */
import { describe, expect, it, vi } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ftsEligibleToken, resetFtsReadyMemo } from "../../src/recall/fts";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { recallEntries } from "../../src/recall/search";
import { tokenizeQuery } from "../../src/text/tokenize";
import type { RecallDiagnostics, RecallInternalOptions } from "../../src/recall/types";
import type { Env } from "../../src/env";
import {
  HIDDEN_VALIDATION_CASES,
} from "../fixtures/recall-root-quality-hidden";
import type { CandidateFixture, RootQualityCase } from "../fixtures/recall-root-quality";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import {
  baselineRecall,
  directTopFourRegressed,
  rawCandidates,
} from "../helpers/recall-benchmark-scoring";

const TOP_K = 5;
const MODES = ["like", "fts-orderless", "fts"] as const;
type Mode = typeof MODES[number];

interface CaseObservation {
  id: string;
  domain: RootQualityCase["domain"];
  failureShape: RootQualityCase["failureShape"];
  candidateAvailable: boolean;
  fused: boolean;
  seed: boolean;
  expanded: boolean;
  selectedRelatedIds: string[];
  authoritative: boolean;
  baselineAuthoritative: boolean;
  directTopFourRegression: boolean;
  extraAiCalls: number;
  extraVectorizeQueries: number;
  ftsUsed?: boolean;
  hasShortToken: boolean;
  diagnostics: RecallDiagnostics;
}

interface BenchmarkMetrics {
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

const caseId = (c: RootQualityCase) => `${c.domain}/${c.failureShape}/${c.query}`;

function hasSubThreeToken(query: string): boolean {
  return tokenizeQuery(query).some(t => !ftsEligibleToken(t));
}

async function buildFixture(c: RootQualityCase, mode: Mode) {
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
        metadata: {
          parentId: candidate.id,
          content: candidate.vectorContent,
          created_at: candidate.createdAt ?? 1,
        },
      })),
  });
  const env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query }),
  });
  await initializeDatabase(env);

  for (const candidate of c.candidates) {
    sqlite.seed({
      id: candidate.id,
      content: candidate.content,
      createdAt: candidate.createdAt ?? 1,
      tags: [...(candidate.tags ?? [])],
      source: "hidden-validation",
    });
    if (candidate.recallCount) {
      await sqlite.db.prepare(`UPDATE entries SET recall_count = ? WHERE id = ?`)
        .bind(candidate.recallCount, candidate.id).run();
    }
  }
  for (const [index, edge] of c.edges.entries()) {
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', 1, 1)`,
    ).bind(`${caseId(c)}-edge-${index}`, edge.sourceId, edge.targetId, edge.type, edge.weight, edge.provenance).run();
  }

  if (mode !== "like") {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
  }

  const pendingWaits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pendingWaits.push(p); } } as unknown as ExecutionContext;
  const internal: RecallInternalOptions = mode === "fts-orderless" ? { keywordPreRankedOverride: false } : {};
  return { env, ctx, query, sqlite, internal, pendingWaits };
}

async function runCase(c: RootQualityCase, mode: Mode): Promise<CaseObservation> {
  const graph = await buildFixture(c, mode);
  try {
    const diagnostics: RecallDiagnostics = {};
    const withGraph = await recallEntries(
      { query: c.query, topK: TOP_K, hops: 1, synthesize: false },
      graph.env,
      graph.ctx,
      undefined,
      { diagnostics, ...graph.internal },
    );
    const acceptableRoots = new Set(c.acceptableRootIds);
    const authoritative = new Set(c.authoritativeIds);
    const raw = rawCandidates(c);
    const candidateAvailable = raw.some(candidate => acceptableRoots.has(candidate.id) || authoritative.has(candidate.id));
    const baseline = baselineRecall(c, withGraph.queryTokens ?? [], TOP_K);
    const outputIds = withGraph.matches.map(match => match.id);
    const graphAiCalls = (graph.env.AI.run as ReturnType<typeof vi.fn>).mock.calls.length;
    await Promise.all(graph.pendingWaits);
    return {
      id: caseId(c),
      domain: c.domain,
      failureShape: c.failureShape,
      candidateAvailable,
      fused: (diagnostics.fusedIds ?? []).some(id => acceptableRoots.has(id)),
      seed: (diagnostics.rootSelections ?? []).some(selection => acceptableRoots.has(selection.id)),
      expanded: (diagnostics.expandedIds ?? []).some(id => authoritative.has(id)),
      selectedRelatedIds: diagnostics.selectedRelatedIds ?? [],
      authoritative: outputIds.some(id => authoritative.has(id)),
      baselineAuthoritative: baseline.outputIds.some(id => authoritative.has(id)),
      directTopFourRegression: directTopFourRegressed(outputIds, baseline.directIds),
      extraAiCalls: Math.max(0, graphAiCalls - 1),
      extraVectorizeQueries: Math.max(0, graph.query.mock.calls.length - 1),
      ftsUsed: diagnostics.ftsUsed,
      hasShortToken: hasSubThreeToken(c.query),
      diagnostics,
    };
  } finally {
    graph.sqlite.close();
  }
}

function summarize(observations: CaseObservation[]): BenchmarkMetrics {
  const selected = observations.flatMap(observation =>
    observation.selectedRelatedIds.map(id => ({ observation, id })));
  const useful = selected.filter(({ observation, id }) => {
    const c = HIDDEN_VALIDATION_CASES.find(candidate => caseId(candidate) === observation.id)!;
    return c.authoritativeIds.includes(id);
  }).length;
  const authoritativeAnswers = observations.filter(row => row.authoritative).length;
  const baselineAuthoritativeAnswers = observations.filter(row => row.baselineAuthoritative).length;
  return {
    cases: observations.length,
    candidateAvailability: observations.filter(row => row.candidateAvailable).length,
    fusionSurvival: observations.filter(row => row.fused).length,
    seedHits: observations.filter(row => row.candidateAvailable && row.seed).length,
    neighborhoodReach: observations.filter(row => row.expanded).length,
    authoritativeAnswers,
    baselineAuthoritativeAnswers,
    improvement: authoritativeAnswers - baselineAuthoritativeAnswers,
    usefulGraphPrecision: selected.length ? useful / selected.length : 1,
    directTopFourRegressions: observations.filter(row => row.directTopFourRegression).length,
    extraAiCalls: observations.reduce((sum, row) => sum + row.extraAiCalls, 0),
    extraVectorizeQueries: observations.reduce((sum, row) => sum + row.extraVectorizeQueries, 0),
  };
}

async function evaluate(mode: Mode) {
  const observations: CaseObservation[] = [];
  for (const c of HIDDEN_VALIDATION_CASES) observations.push(await runCase(c, mode));
  for (const observation of observations) {
    if (!observation.hasShortToken) {
      expect(observation.ftsUsed, `${observation.id} (${mode})`).toBe(mode !== "like");
    }
  }
  return { observations, metrics: summarize(observations) };
}

function reportMetrics(mode: Mode, metrics: BenchmarkMetrics): void {
  if (process.env.RECALL_BENCHMARK_REPORT === "1") {
    console.info(`HIDDEN_VALIDATION_SQLITE ${mode} ${JSON.stringify(metrics)}`);
  }
}

/** The original's frozen ship gates, asserted here in every one of the three modes. */
function assertFrozenGates(mode: Mode, metrics: BenchmarkMetrics, observations: CaseObservation[]) {
  const byDomain = Object.fromEntries(
    (["personal", "enterprise", "product", "architecture"] as const).map(domain => [
      domain,
      summarize(observations.filter(row => row.domain === domain)),
    ]),
  );
  const details = JSON.stringify({ mode, metrics, byDomain, observations }, null, 2);
  expect(metrics.cases, details).toBe(10);
  expect(metrics.candidateAvailability, details).toBe(8);
  expect(metrics.seedHits, details).toBeGreaterThanOrEqual(7);
  expect(metrics.usefulGraphPrecision, details).toBeGreaterThanOrEqual(0.7);
  expect(metrics.improvement, details).toBeGreaterThanOrEqual(2);
  expect(metrics.directTopFourRegressions, details).toBe(0);
  expect(metrics.extraAiCalls, details).toBe(0);
  expect(metrics.extraVectorizeQueries, details).toBe(0);
  for (const domain of Object.keys(byDomain) as (keyof typeof byDomain)[]) {
    expect(byDomain[domain].authoritativeAnswers, details).toBeGreaterThanOrEqual(byDomain[domain].baselineAuthoritativeAnswers);
  }
}

describe("real-SQLite hidden recall validation", () => {
  it.each(MODES)("meets the frozen ten-case ship gates: %s mode", async (mode) => {
    const { observations, metrics } = await evaluate(mode);
    reportMetrics(mode, metrics);
    assertFrozenGates(mode, metrics, observations);
  });

  it("fts-orderless and fts never score below the mode they build on", async () => {
    const byMode = {} as Record<Mode, BenchmarkMetrics>;
    const byModeObs = {} as Record<Mode, CaseObservation[]>;
    for (const mode of MODES) {
      const { observations, metrics } = await evaluate(mode);
      byMode[mode] = metrics;
      byModeObs[mode] = observations;
    }
    if (process.env.RECALL_BENCHMARK_REPORT === "1") {
      console.info(`HIDDEN_VALIDATION_SQLITE_COMPARISON ${JSON.stringify(byMode)}`);
    }
    const flips = (a: Mode, b: Mode) => byModeObs[a]
      .map((obs, i) => ({ id: obs.id, [a]: obs.authoritative, [b]: byModeObs[b][i].authoritative }))
      .filter(row => (row as Record<string, unknown>)[a] !== (row as Record<string, unknown>)[b]);
    const details = JSON.stringify({
      byMode,
      likeToOrderlessFlips: flips("like", "fts-orderless"),
      orderlessToFtsFlips: flips("fts-orderless", "fts"),
    }, null, 2);

    expect(byMode["fts-orderless"].authoritativeAnswers, details).toBeGreaterThanOrEqual(byMode.like.authoritativeAnswers);
    expect(byMode["fts-orderless"].directTopFourRegressions, details).toBeLessThanOrEqual(byMode.like.directTopFourRegressions);
    expect(byMode.fts.authoritativeAnswers, details).toBeGreaterThanOrEqual(byMode["fts-orderless"].authoritativeAnswers);
    expect(byMode.fts.directTopFourRegressions, details).toBeLessThanOrEqual(byMode["fts-orderless"].directTopFourRegressions);
  });

  it("real LIKE vs the mock's canned keyword rows (reported: hidden 5 vs 2, 0 regressions, candidateAvailability 8, fusionSurvival 8, seedHits 8)", async () => {
    const { metrics, observations } = await evaluate("like");
    const mockCanned = { authoritativeAnswers: 5, baselineAuthoritativeAnswers: 2, directTopFourRegressions: 0, candidateAvailability: 8, fusionSurvival: 8, seedHits: 8 };
    console.info(`HIDDEN_VALIDATION_SQLITE_LIKE_VS_MOCK ${JSON.stringify({
      real: {
        authoritativeAnswers: metrics.authoritativeAnswers,
        baselineAuthoritativeAnswers: metrics.baselineAuthoritativeAnswers,
        directTopFourRegressions: metrics.directTopFourRegressions,
        candidateAvailability: metrics.candidateAvailability,
        fusionSurvival: metrics.fusionSurvival,
        seedHits: metrics.seedHits,
      },
      mockCanned,
    })}`);
    expect(metrics.candidateAvailability, JSON.stringify(observations, null, 2)).toBe(mockCanned.candidateAvailability);
  });
});
