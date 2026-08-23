import { createHash } from "node:crypto";
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
  HIDDEN_VALIDATION_CASES,
  HIDDEN_VALIDATION_MANIFEST,
  HIDDEN_VALIDATION_SERIALIZATION,
  HIDDEN_VALIDATION_SHA256,
} from "../fixtures/recall-root-quality-hidden";
import {
  ROOT_QUALITY_CASES,
  type CandidateFixture,
  type RootQualityCase,
} from "../fixtures/recall-root-quality";
import { D1Mock } from "../helpers/d1-mock";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";

const TOP_K = 5;

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
const rawCandidates = (c: RootQualityCase) =>
  c.candidates.filter(candidate => candidate.denseScore !== undefined || candidate.keywordCandidate);
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

const escapeRegExp = (value: string) => value.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");

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
        : {
          parentId: id,
          content: candidate.content,
          created_at: candidate.createdAt ?? 1,
          tags: candidate.tags ?? [],
        },
    };
  });
}

function baselineRecall(
  c: RootQualityCase,
  tokens: string[],
): { outputIds: string[]; directIds: string[]; rootIds: string[] } {
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
          first: async () => c.failureShape === "weak-generic-neighbor"
            || c.failureShape === "long-parent-pollution"
            ? Promise.reject(new Error("controlled corpus scan unavailable"))
            : Object.fromEntries([
              ["total", 100],
              ...patterns.map((_, index) => [`d${index}`, 2]),
            ]),
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
          source: "hidden-validation",
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
      source: "hidden-validation",
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
      .filter((candidate): candidate is CandidateFixture & { denseScore: number } =>
        candidate.denseScore !== undefined)
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
  const raw = rawCandidates(c);
  const candidateAvailable = raw.some(candidate =>
    acceptableRoots.has(candidate.id) || authoritative.has(candidate.id));
  const baseline = baselineRecall(c, withGraph.queryTokens ?? []);
  const outputIds = withGraph.matches.map(match => match.id);
  const graphAiCalls = (graph.env.AI.run as ReturnType<typeof vi.fn>).mock.calls.length;
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
    diagnostics,
  };
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

async function evaluate(cases: readonly RootQualityCase[]) {
  const observations: CaseObservation[] = [];
  for (const c of cases) observations.push(await runCase(c));
  return { observations, metrics: summarize(observations) };
}

function geometry(c: RootQualityCase) {
  const dense = c.candidates
    .filter((candidate): candidate is CandidateFixture & { denseScore: number } =>
      candidate.denseScore !== undefined)
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
    edgeShape: JSON.stringify(c.edges.map(edge => [
      edge.type,
      edge.weight,
      edge.provenance,
      edge.sourceId === c.acceptableRootIds[0],
    ])),
    queryShape: `${c.query.split(/\s+/).length}/${new Set(c.query.toLowerCase().split(/\s+/)).size}`,
  };
}

describe("hidden recall validation structure", () => {
  it("preserves the sealed manifest digest and recursive freeze", () => {
    expect(HIDDEN_VALIDATION_SERIALIZATION).toBe("UTF-8 JSON.stringify insertion-order v1");
    expect(createHash("sha256").update(JSON.stringify(HIDDEN_VALIDATION_MANIFEST), "utf8").digest("hex"))
      .toBe(HIDDEN_VALIDATION_SHA256);
    expect(HIDDEN_VALIDATION_SHA256)
      .toBe("319c2553d379d2bf215f97ae89018e01658de15f8ddaceb21feda38f67ee9462");
    expect(Object.isFrozen(HIDDEN_VALIDATION_MANIFEST)).toBe(true);
    expect(Object.isFrozen(HIDDEN_VALIDATION_CASES)).toBe(true);
    for (const c of HIDDEN_VALIDATION_CASES) {
      expect(Object.isFrozen(c), caseId(c)).toBe(true);
      expect(Object.isFrozen(c.candidates), caseId(c)).toBe(true);
      expect(Object.isFrozen(c.edges), caseId(c)).toBe(true);
      expect(Object.isFrozen(c.authoritativeIds), caseId(c)).toBe(true);
      expect(Object.isFrozen(c.acceptableRootIds), caseId(c)).toBe(true);
    }
  });

  it("keeps the sealed balance, literal oracles, declared intents, and raw availability", () => {
    expect(HIDDEN_VALIDATION_CASES).toHaveLength(10);
    expect(HIDDEN_VALIDATION_CASES.filter(c => c.candidateAvailable)).toHaveLength(8);
    expect(HIDDEN_VALIDATION_CASES.filter(c => !c.candidateAvailable)).toHaveLength(2);
    expect(new Set(HIDDEN_VALIDATION_CASES.map(c => c.failureShape))).toEqual(new Set([
      "crowded-lexical-root",
      "popular-broad-summary",
      "long-parent-pollution",
      "weak-generic-neighbor",
      "absent-cluster-control",
    ]));
    for (const shape of new Set(HIDDEN_VALIDATION_CASES.map(c => c.failureShape))) {
      expect(HIDDEN_VALIDATION_CASES.filter(c => c.failureShape === shape)).toHaveLength(2);
    }
    expect(Object.fromEntries(
      ["personal", "enterprise", "product", "architecture"].map(domain => [
        domain,
        HIDDEN_VALIDATION_CASES.filter(c => c.domain === domain).length,
      ]),
    )).toEqual({ personal: 3, enterprise: 3, product: 2, architecture: 2 });
    for (const c of HIDDEN_VALIDATION_CASES) {
      expect(c.authoritativeIds.every(id => id.startsWith("fh-")), caseId(c)).toBe(true);
      const observed = rawCandidates(c).some(candidate =>
        c.acceptableRootIds.includes(candidate.id) || c.authoritativeIds.includes(candidate.id));
      expect(observed, caseId(c)).toBe(c.candidateAvailable);
      expect(["causal", "chronology", "current", "direct"], caseId(c)).toContain(c.intent);
    }
  });

  it("keeps every hidden geometry materially distinct from both existing splits", () => {
    const dimensions = Object.keys(geometry(HIDDEN_VALIDATION_CASES[0])) as
      (keyof ReturnType<typeof geometry>)[];
    for (const hidden of HIDDEN_VALIDATION_CASES) {
      for (const existing of ROOT_QUALITY_CASES.filter(c => c.failureShape === hidden.failureShape)) {
        const hiddenGeometry = geometry(hidden);
        const existingGeometry = geometry(existing);
        const differences = dimensions.filter(dimension =>
          hiddenGeometry[dimension] !== existingGeometry[dimension]);
        expect(
          differences.length,
          `${caseId(hidden)} vs ${caseId(existing)}: ${JSON.stringify({
            hiddenGeometry,
            existingGeometry,
          })}`,
        ).toBeGreaterThanOrEqual(5);
      }
    }
  });
});

describe("sealed hidden recall validation regression", () => {
  it("enforces the frozen ten-case ship gates", async () => {
    const { observations, metrics } = await evaluate(HIDDEN_VALIDATION_CASES);
    const byDomain = Object.fromEntries(
      (["personal", "enterprise", "product", "architecture"] as const).map(domain => [
        domain,
        summarize(observations.filter(row => row.domain === domain)),
      ]),
    );
    const funnel = {
      runtimeIntentMismatches: HIDDEN_VALIDATION_CASES.flatMap(c => {
        const runtime = buildQueryProfile(c.query, { query: c.query, df: null, total: null }).intent;
        return runtime === c.intent ? [] : [{ id: caseId(c), declared: c.intent, runtime }];
      }),
      candidateGenerationMisses: observations.filter(row => !row.candidateAvailable).map(row => row.id),
      fusionMisses: observations.filter(row => row.candidateAvailable && !row.fused).map(row => row.id),
      seedMisses: observations.filter(row => row.candidateAvailable && !row.seed).map(row => row.id),
      reachMisses: observations.filter(row => row.candidateAvailable && !row.expanded).map(row => row.id),
      answerMisses: observations.filter(row => !row.authoritative).map(row => row.id),
    };
    const report = { digest: HIDDEN_VALIDATION_SHA256, metrics, byDomain, funnel, observations };
    console.info(`HIDDEN_VALIDATION_RESULT ${JSON.stringify(report)}`);

    expect(metrics.cases, JSON.stringify(report, null, 2)).toBe(10);
    expect(metrics.candidateAvailability, JSON.stringify(report, null, 2)).toBe(8);
    expect(metrics.seedHits, JSON.stringify(report, null, 2)).toBeGreaterThanOrEqual(7);
    expect(metrics.usefulGraphPrecision, JSON.stringify(report, null, 2)).toBeGreaterThanOrEqual(0.7);
    expect(metrics.improvement, JSON.stringify(report, null, 2)).toBeGreaterThanOrEqual(2);
    expect(metrics.directTopFourRegressions, JSON.stringify(report, null, 2)).toBe(0);
    expect(metrics.extraAiCalls, JSON.stringify(report, null, 2)).toBe(0);
    expect(metrics.extraVectorizeQueries, JSON.stringify(report, null, 2)).toBe(0);
    for (const domain of Object.keys(byDomain) as (keyof typeof byDomain)[]) {
      expect(
        byDomain[domain].authoritativeAnswers,
        JSON.stringify({ domain, metrics: byDomain[domain] }, null, 2),
      ).toBeGreaterThanOrEqual(byDomain[domain].baselineAuthoritativeAnswers);
    }
  });
});
