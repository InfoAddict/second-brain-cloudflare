import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { graphSeedLimit, relatedSlotLimit } from "../../src/recall/neighborhood";
import { mmrRerank, rerankWithTimeDecay, type VectorizeMatch } from "../../src/recall/math";
import { buildQueryProfile } from "../../src/recall/query-profile";
import type { RootCandidate } from "../../src/recall/root-selector";
import { rrfFuse } from "../../src/recall/rrf";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import {
  ROOT_QUALITY_CASES,
  type CandidateFixture,
  type RootQualityCase,
  type RootQualitySplit,
} from "../fixtures/recall-root-quality";
import { D1Mock } from "../helpers/d1-mock";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";

const TOP_K = 5;

interface CaseObservation {
  id: string;
  split: RootQualitySplit;
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

const caseId = (c: RootQualityCase) => `${c.domain}/${c.failureShape}`;
const rawCandidates = (c: RootQualityCase) => c.candidates.filter(candidate => candidate.denseScore !== undefined || candidate.keywordCandidate);
const directTopFourRegressed = (currentIds: string[], baselineIds: string[]) =>
  JSON.stringify(currentIds.slice(0, 4)) !== JSON.stringify(baselineIds.slice(0, 4));

function baselineRootIds(candidates: RootCandidate[], topK: number, lambda: number): string[] {
  return mmrRerank(candidates, lambda, graphSeedLimit(topK, candidates.length))
    .map(candidate => candidate.parentId);
}

function baselineLinkedEligible(content: string, tokens: string[]): boolean {
  const lower = content.toLowerCase();
  return tokens.some(token => lower.includes(token.toLowerCase()));
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function frozenBaselineCorpus(c: RootQualityCase, tokens: string[]) {
  return c.failureShape === "weak-generic-neighbor" || c.failureShape === "long-parent-pollution"
    ? { df: null, total: null }
    : { df: new Map(tokens.map(token => [token, 2])), total: 100 };
}

function frozenPrePlanFused(c: RootQualityCase, tokens: string[]): VectorizeMatch[] {
  const dense = c.candidates
    .filter((candidate): candidate is CandidateFixture & { denseScore: number } => candidate.denseScore !== undefined)
    .slice()
    .sort((a, b) => b.denseScore - a.denseScore);
  const denseById = new Map(dense.map(candidate => [candidate.id, candidate]));
  const keyword = c.candidates.filter(candidate => candidate.keywordCandidate);
  const corpus = frozenBaselineCorpus(c, tokens);
  const hasCorpusIdf = !!corpus.df && !!corpus.total && tokens.every(token => corpus.df!.has(token));
  const keywordN = keyword.length || 1;
  const keywordDf = new Map(tokens.map(token => [
    token,
    keyword.filter(candidate => candidate.content.toLowerCase().includes(token.toLowerCase())).length,
  ]));
  const idf = (token: string) => hasCorpusIdf
    ? Math.log(1 + corpus.total! / ((corpus.df!.get(token) ?? 0) + 1))
    : Math.log(1 + keywordN / ((keywordDf.get(token) ?? 0) + 1));
  const keywordRanked = keyword
    .map(candidate => {
      const lower = candidate.content.toLowerCase();
      const weight = tokens.reduce((sum, token) => {
        const normalized = token.toLowerCase();
        if (!lower.includes(normalized)) return sum;
        const exact = new RegExp(`(?<![\\w])${escapeRegExp(normalized)}(?![\\w])`).test(lower);
        return sum + idf(token) * (exact ? 1 : DEFAULTS.SUBSTRING_MATCH_WEIGHT);
      }, 0);
      return { candidate, weight };
    })
    .filter(row => row.weight > 0)
    .sort((a, b) => b.weight - a.weight
      || (b.candidate.createdAt ?? 1) - (a.candidate.createdAt ?? 1)
      || a.candidate.id.localeCompare(b.candidate.id));
  const fused = rrfFuse(
    dense.map(candidate => candidate.id),
    keywordRanked.map(row => ({ id: row.candidate.id, weight: row.weight })),
  );
  const byId = new Map(c.candidates.map(candidate => [candidate.id, candidate]));
  return [...fused].map(([id, score]) => {
    const candidate = byId.get(id)!;
    const denseCandidate = denseById.get(id);
    return {
      id,
      score,
      metadata: denseCandidate
        ? { parentId: id, content: denseCandidate.vectorContent, created_at: denseCandidate.createdAt ?? 1 }
        : { parentId: id, content: candidate.content, created_at: candidate.createdAt ?? 1, tags: candidate.tags ?? [] },
    };
  });
}

function baselineRecall(c: RootQualityCase, tokens: string[]): { outputIds: string[]; directIds: string[]; rootIds: string[] } {
  const fixtures = rawCandidates(c);
  const recallCounts = new Map(fixtures.map(candidate => [candidate.id, candidate.recallCount ?? 0]));
  const tags = new Map(fixtures.map(candidate => [candidate.id, [...(candidate.tags ?? [])]]));
  const reranked = rerankWithTimeDecay(
    frozenPrePlanFused(c, tokens),
    recallCounts,
    new Map(),
    [],
    new Map(),
    new Map(),
    tags,
    DEFAULTS,
  );
  const candidates: RootCandidate[] = reranked.map(match => ({
    ...match,
    parentId: match.id,
    rootScore: match.score,
    localEvidence: c.candidates.find(candidate => candidate.id === match.id)?.vectorContent ?? "",
    tags: tags.get(match.id) ?? [],
    lexicalCoverage: 0,
    metadataAlignment: 0,
  }));
  const roots = new Set(baselineRootIds(candidates, TOP_K, DEFAULTS.MMR_LAMBDA));
  const directIds = mmrRerank(reranked, DEFAULTS.MMR_LAMBDA, TOP_K).map(candidate => candidate.id);
  const rows = new Map(c.candidates.map(candidate => [candidate.id, candidate]));
  const related = c.edges
    .flatMap(edge => {
      const linkedId = roots.has(edge.sourceId)
        ? edge.targetId
        : roots.has(edge.targetId)
          ? edge.sourceId
          : undefined;
      if (!linkedId || directIds.includes(linkedId)) return [];
      const linked = rows.get(linkedId);
      return linked && baselineLinkedEligible(linked.content, tokens) ? [linkedId] : [];
    })
    .slice(0, relatedSlotLimit(TOP_K));
  return {
    outputIds: [...directIds.slice(0, TOP_K - related.length), ...related],
    directIds,
    rootIds: [...roots],
  };
}

function installControlledQueries(db: D1Mock, c: RootQualityCase): void {
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (sql.includes("SELECT COUNT(*) AS total") && sql.includes("SUM(CASE WHEN content LIKE")) {
      return {
        bind: (...patterns: string[]) => ({
          first: async () => {
            // Keep the eight-token weak-neighborhood query intact so its two generic
            // matches clear the lexical-count gate but remain below the score threshold.
            if (c.failureShape === "weak-generic-neighbor" || c.failureShape === "long-parent-pollution") {
              throw new Error("controlled corpus scan unavailable");
            }
            return Object.fromEntries([
              ["total", 100],
              ...patterns.map((_, index) => [`d${index}`, 2]),
            ]);
          },
        }),
      };
    }
    if (sql.includes("WHERE content LIKE") && sql.includes("ORDER BY created_at DESC LIMIT")) {
      const results = c.candidates
        .filter(candidate => candidate.keywordCandidate)
        .map(candidate => ({
          id: candidate.id,
          content: candidate.content,
          tags: JSON.stringify(candidate.tags ?? []),
          source: "benchmark",
          created_at: candidate.createdAt ?? 1,
        }));
      return { bind: () => ({ all: async () => ({ results }) }) };
    }
    return prepare(sql);
  };
}

function buildFixture(c: RootQualityCase) {
  const db = new D1Mock();
  for (const candidate of c.candidates) {
    db.entries.push({
      id: candidate.id,
      content: candidate.content,
      tags: JSON.stringify(candidate.tags ?? []),
      source: "benchmark",
      created_at: candidate.createdAt ?? 1,
      updated_at: candidate.createdAt ?? 1,
      vector_ids: "[]",
      recall_count: candidate.recallCount ?? 0,
      importance_score: 0,
      contradiction_wins: 0,
      contradiction_losses: 0,
    });
  }
  for (const [index, edge] of c.edges.entries()) {
    db.edges.push({
      id: `${caseId(c)}-edge-${index}`,
      source_id: edge.sourceId,
      target_id: edge.targetId,
      type: edge.type,
      weight: edge.weight,
      provenance: edge.provenance,
      metadata: "{}",
      created_at: 1,
      updated_at: 1,
    });
  }
  installControlledQueries(db, c);
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
  const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query }) });
  const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined } as unknown as ExecutionContext;
  return { env, ctx, query };
}

async function runCase(c: RootQualityCase): Promise<CaseObservation> {
  const graph = buildFixture(c);
  const diagnostics: RecallDiagnostics = {};
  const withGraph = await recallEntries(
    { query: c.query, topK: TOP_K, hops: 1, synthesize: false },
    graph.env,
    graph.ctx,
    undefined,
    { diagnostics },
  );
  const acceptableRoots = new Set(c.acceptableRootIds);
  const authoritative = new Set(c.authoritativeIds);
  const candidateAvailable = rawCandidates(c).some(candidate => acceptableRoots.has(candidate.id) || authoritative.has(candidate.id));
  const fused = (diagnostics.fusedIds ?? []).some(id => acceptableRoots.has(id));
  const seed = (diagnostics.rootSelections ?? []).some(selection => acceptableRoots.has(selection.id));
  const expanded = (diagnostics.expandedIds ?? []).some(id => authoritative.has(id));
  const outputIds = withGraph.matches.map(match => match.id);
  const baseline = baselineRecall(c, withGraph.queryTokens ?? []);
  const graphAiCalls = (graph.env.AI.run as ReturnType<typeof vi.fn>).mock.calls.length;

  return {
    id: caseId(c),
    split: c.split,
    candidateAvailable,
    fused,
    seed,
    expanded,
    selectedRelatedIds: diagnostics.selectedRelatedIds ?? [],
    authoritative: outputIds.some(id => authoritative.has(id)),
    baselineAuthoritative: baseline.outputIds.some(id => authoritative.has(id)),
    directTopFourRegression: directTopFourRegressed(outputIds, baseline.directIds),
    extraAiCalls: Math.max(0, graphAiCalls - 1),
    extraVectorizeQueries: Math.max(0, graph.query.mock.calls.length - 1),
    diagnostics,
  };
}

function summarize(observations: CaseObservation[]): BenchmarkMetrics {
  const selectedRelatedIds = observations.flatMap(observation => observation.selectedRelatedIds.map(id => ({ observation, id })));
  const usefulRelated = selectedRelatedIds.filter(({ observation, id }) => {
    const c = ROOT_QUALITY_CASES.find(candidate => caseId(candidate) === observation.id)!;
    return c.authoritativeIds.includes(id);
  }).length;
  const authoritativeAnswers = observations.filter(observation => observation.authoritative).length;
  const baselineAuthoritativeAnswers = observations.filter(observation => observation.baselineAuthoritative).length;
  return {
    cases: observations.length,
    candidateAvailability: observations.filter(observation => observation.candidateAvailable).length,
    fusionSurvival: observations.filter(observation => observation.fused).length,
    seedHits: observations.filter(observation => observation.candidateAvailable && observation.seed).length,
    neighborhoodReach: observations.filter(observation => observation.expanded).length,
    authoritativeAnswers,
    baselineAuthoritativeAnswers,
    improvement: authoritativeAnswers - baselineAuthoritativeAnswers,
    usefulGraphPrecision: selectedRelatedIds.length ? usefulRelated / selectedRelatedIds.length : 1,
    directTopFourRegressions: observations.filter(observation => observation.directTopFourRegression).length,
    extraAiCalls: observations.reduce((sum, observation) => sum + observation.extraAiCalls, 0),
    extraVectorizeQueries: observations.reduce((sum, observation) => sum + observation.extraVectorizeQueries, 0),
  };
}

async function evaluate(cases: readonly RootQualityCase[]) {
  const observations = [] as CaseObservation[];
  for (const c of cases) observations.push(await runCase(c));
  return { observations, metrics: summarize(observations) };
}

function reportMetrics(label: string, metrics: BenchmarkMetrics): void {
  if (process.env.RECALL_BENCHMARK_REPORT === "1") {
    console.info(`RECALL_ROOT_QUALITY ${label} ${JSON.stringify(metrics)}`);
  }
}

function expectSplitGates(split: RootQualitySplit, metrics: BenchmarkMetrics, observations: CaseObservation[]) {
  const details = JSON.stringify({ split, metrics, observations }, null, 2);
  expect(metrics.cases, details).toBe(10);
  expect(metrics.candidateAvailability, details).toBe(8);
  expect(metrics.fusionSurvival, details).toBe(8);
  expect(metrics.seedHits, details).toBeGreaterThanOrEqual(split === "development" ? 7 : 6);
  expect(metrics.usefulGraphPrecision, details).toBeGreaterThanOrEqual(0.7);
  expect(metrics.directTopFourRegressions, details).toBe(0);
  expect(metrics.extraAiCalls, details).toBe(0);
  expect(metrics.extraVectorizeQueries, details).toBe(0);
}

describe("frozen recall root-quality fixture", () => {
  it("matches every declared intent to the runtime query profiler", () => {
    for (const c of ROOT_QUALITY_CASES) {
      expect(buildQueryProfile(c.query, { query: c.query, df: null, total: null }).intent, caseId(c)).toBe(c.intent);
    }
  });

  it("freezes nested candidate, edge, and authoritative-ID structures", () => {
    expect(Object.isFrozen(ROOT_QUALITY_CASES)).toBe(true);
    for (const c of ROOT_QUALITY_CASES) {
      expect(Object.isFrozen(c), caseId(c)).toBe(true);
      expect(Object.isFrozen(c.candidates), `${caseId(c)}/candidates`).toBe(true);
      for (const candidate of c.candidates) {
        expect(Object.isFrozen(candidate), `${caseId(c)}/${candidate.id}`).toBe(true);
        if (candidate.tags) expect(Object.isFrozen(candidate.tags), `${caseId(c)}/${candidate.id}/tags`).toBe(true);
      }
      expect(Object.isFrozen(c.edges), `${caseId(c)}/edges`).toBe(true);
      for (const edge of c.edges) expect(Object.isFrozen(edge), `${caseId(c)}/${edge.sourceId}->${edge.targetId}`).toBe(true);
      expect(Object.isFrozen(c.authoritativeIds), `${caseId(c)}/authoritativeIds`).toBe(true);
      expect(Object.isFrozen(c.acceptableRootIds), `${caseId(c)}/acceptableRootIds`).toBe(true);
    }
  });

  it("keeps every holdout geometry materially distinct from development cases of the same shape", () => {
    const geometry = (c: RootQualityCase) => {
      const dense = c.candidates
        .filter((candidate): candidate is CandidateFixture & { denseScore: number } => candidate.denseScore !== undefined)
        .slice()
        .sort((a, b) => b.denseScore - a.denseScore);
      const rootPositions = c.acceptableRootIds.map(id => dense.findIndex(candidate => candidate.id === id));
      const root = dense.find(candidate => c.acceptableRootIds.includes(candidate.id));
      return {
        rawCount: rawCandidates(c).length,
        denseCount: dense.length,
        keywordCount: c.candidates.filter(candidate => candidate.keywordCandidate).length,
        rootPositions: JSON.stringify(rootPositions),
        rootGap: root ? Number((dense[0].denseScore - root.denseScore).toFixed(3)) : null,
        recallMax: Math.max(0, ...c.candidates.map(candidate => candidate.recallCount ?? 0)),
        edgeShape: JSON.stringify(c.edges.map(edge => [edge.type, edge.weight, edge.provenance, edge.sourceId === c.acceptableRootIds[0]])),
        queryShape: `${c.query.split(/\s+/).length}/${new Set(c.query.toLowerCase().split(/\s+/)).size}`,
      };
    };
    const dimensions = Object.keys(geometry(ROOT_QUALITY_CASES[0])) as (keyof ReturnType<typeof geometry>)[];

    for (const holdout of ROOT_QUALITY_CASES.filter(c => c.split === "holdout")) {
      for (const development of ROOT_QUALITY_CASES.filter(c => c.split === "development" && c.failureShape === holdout.failureShape)) {
        const holdoutGeometry = geometry(holdout);
        const developmentGeometry = geometry(development);
        const differences = dimensions.filter(dimension => holdoutGeometry[dimension] !== developmentGeometry[dimension]);
        expect(differences.length, `${caseId(holdout)} versus ${caseId(development)}: ${JSON.stringify({ holdoutGeometry, developmentGeometry })}`).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it("detects a direct top-four regression against the frozen pre-plan order", () => {
    expect(directTopFourRegressed(
      ["direct-a", "direct-c", "direct-b", "direct-d"],
      ["direct-a", "direct-b", "direct-c", "direct-d"],
    )).toBe(true);
  });

  it("the frozen pre-plan baseline fuses the same dense and keyword raw inputs with RRF", () => {
    const probe: RootQualityCase = {
      split: "development",
      domain: "architecture",
      failureShape: "crowded-lexical-root",
      query: "quasar",
      intent: "direct",
      candidates: [
        { id: "dense-a", content: "dense a", denseScore: 0.9 },
        { id: "dense-b", content: "dense b", denseScore: 0.8 },
        { id: "keyword", content: "quasar nebula orbit", keywordCandidate: true },
      ],
      edges: [],
      authoritativeIds: ["keyword"],
      acceptableRootIds: [],
      candidateAvailable: true,
    };

    expect(baselineRecall(probe, ["quasar", "nebula", "orbit"]).directIds[0]).toBe("keyword");
  });

  it("contains no manually editable baseline relevance labels", () => {
    for (const c of ROOT_QUALITY_CASES) {
      for (const candidate of c.candidates) {
        expect("baselineScore" in candidate, `${caseId(c)}/${candidate.id}`).toBe(false);
      }
    }
  });

  it("derives candidate availability from a raw authoritative candidate without benchmark labels", async () => {
    const absent = ROOT_QUALITY_CASES.find(c => c.failureShape === "absent-cluster-control")!;
    const authoritativeId = absent.authoritativeIds[0];
    const probe: RootQualityCase = {
      ...absent,
      candidateAvailable: true,
      candidates: absent.candidates.map(candidate => candidate.id === authoritativeId
        ? { ...candidate, denseScore: 0.51 }
        : candidate),
    };

    expect((await runCase(probe)).candidateAvailable).toBe(true);
  });

  it("contains 20 generic, alternating development/holdout cases with literal controls", () => {
    expect(ROOT_QUALITY_CASES).toHaveLength(20);
    expect(ROOT_QUALITY_CASES.filter(c => c.split === "development")).toHaveLength(10);
    expect(ROOT_QUALITY_CASES.filter(c => c.split === "holdout")).toHaveLength(10);
    expect(ROOT_QUALITY_CASES.filter(c => !c.candidateAvailable)).toHaveLength(4);
    for (const c of ROOT_QUALITY_CASES) {
      const observed = rawCandidates(c).some(candidate => c.acceptableRootIds.includes(candidate.id) || c.authoritativeIds.includes(candidate.id));
      expect(observed, caseId(c)).toBe(c.candidateAvailable);
    }
    for (const domain of ["personal", "enterprise", "product", "architecture"] as const) {
      const cases = ROOT_QUALITY_CASES.filter(c => c.domain === domain);
      expect(cases).toHaveLength(5);
      expect(new Set(cases.map(c => c.failureShape)).size).toBe(5);
    }
    for (const shape of new Set(ROOT_QUALITY_CASES.map(c => c.failureShape))) {
      expect(new Set(ROOT_QUALITY_CASES.filter(c => c.failureShape === shape).map(c => c.split))).toEqual(new Set(["development", "holdout"]));
    }
  });
});

describe("frozen recall root-quality benchmark", () => {
  it("development aggregate meets the frozen gates", async () => {
    const { observations, metrics } = await evaluate(ROOT_QUALITY_CASES.filter(c => c.split === "development"));
    reportMetrics("development", metrics);
    expectSplitGates("development", metrics, observations);
  });

  it("holdout aggregate meets the frozen gates", async () => {
    const { observations, metrics } = await evaluate(ROOT_QUALITY_CASES.filter(c => c.split === "holdout"));
    reportMetrics("holdout", metrics);
    expectSplitGates("holdout", metrics, observations);
  });

  it("20-case aggregate improves authoritative answers by at least four", async () => {
    const { observations, metrics } = await evaluate(ROOT_QUALITY_CASES);
    reportMetrics("overall", metrics);
    const details = JSON.stringify({ metrics, observations }, null, 2);
    expect(metrics.candidateAvailability, details).toBe(16);
    expect(metrics.seedHits, details).toBeGreaterThanOrEqual(13);
    expect(metrics.authoritativeAnswers, details).toBeGreaterThanOrEqual(14);
    expect(metrics.usefulGraphPrecision, details).toBeGreaterThanOrEqual(0.7);
    expect(metrics.authoritativeAnswers - metrics.baselineAuthoritativeAnswers, details).toBeGreaterThanOrEqual(4);
    expect(metrics.directTopFourRegressions, details).toBe(0);
    expect(metrics.extraAiCalls, details).toBe(0);
    expect(metrics.extraVectorizeQueries, details).toBe(0);
  });

  it("frequency-neutral popularity sentinel keeps the specific root", async () => {
    const c = ROOT_QUALITY_CASES.find(candidate => candidate.failureShape === "popular-broad-summary" && candidate.split === "development")!;
    const observation = await runCase(c);
    expect(observation.diagnostics.rootSelections?.map(selection => selection.id)).toContain(c.acceptableRootIds[0]);
    expect(observation.authoritative).toBe(true);
  });

  it("query-local long-parent sentinel preserves complementary evidence", async () => {
    const c = ROOT_QUALITY_CASES.find(candidate => candidate.failureShape === "long-parent-pollution" && candidate.split === "development")!;
    const observation = await runCase(c);
    expect(observation.expanded).toBe(true);
    expect(observation.authoritative).toBe(true);
  });

  it("full-query evidence recovers omitted complementary terms without direct or call regressions", async () => {
    const cases = ROOT_QUALITY_CASES.filter(candidate =>
      candidate.failureShape === "crowded-lexical-root" && candidate.split === "holdout");
    const observations = await Promise.all(cases.map(runCase));

    expect(observations.map(observation => observation.authoritative)).toEqual([true, true]);
    expect(observations.map(observation => observation.directTopFourRegression)).toEqual([false, false]);
    expect(observations.map(observation => observation.extraAiCalls)).toEqual([0, 0]);
    expect(observations.map(observation => observation.extraVectorizeQueries)).toEqual([0, 0]);
  });

  it("reserved lexical sentinel reaches a crowded specific root", async () => {
    const c = ROOT_QUALITY_CASES.find(candidate => candidate.failureShape === "crowded-lexical-root" && candidate.split === "development")!;
    const observation = await runCase(c);
    expect(observation.diagnostics.rootSelections).toContainEqual({ id: c.acceptableRootIds[0], selectedBy: "lexical" });
    expect(observation.authoritative).toBe(true);
  });

  it("neighborhood threshold backfill sentinel rejects weak generic evidence", async () => {
    const c = ROOT_QUALITY_CASES.find(candidate => candidate.failureShape === "weak-generic-neighbor" && candidate.split === "development")!;
    const observation = await runCase(c);
    expect(observation.diagnostics.selectedRelatedIds).toEqual([]);
    expect(observation.diagnostics.rejections).toContainEqual({ id: `${c.domain}-weak-neighbor`, reason: "weak-neighborhood" });
    expect(observation.authoritative).toBe(true);
    expect(observation.baselineAuthoritative).toBe(false);
  });

  it("AI and Vectorize parity sentinel keeps the controlled path at one call", async () => {
    const c = ROOT_QUALITY_CASES.find(candidate => candidate.failureShape === "crowded-lexical-root" && candidate.split === "development")!;
    const fixture = buildFixture(c);
    await recallEntries({ query: c.query, topK: TOP_K, hops: 1, synthesize: false }, fixture.env, fixture.ctx);
    expect((fixture.env.AI.run as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])).toEqual([DEFAULTS.EMBEDDING_MODEL]);
    expect(fixture.query).toHaveBeenCalledTimes(1);
  });
});
