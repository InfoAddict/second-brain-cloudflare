import type { Env } from "../env";
import {
  D1_MAX_BOUND_PARAMS,
  FTS_MATCH_BUDGET,
  KEYWORD_MAX_TOKENS,
  VECTORIZE_GET_BY_IDS_BATCH,
  RECALL_BLOCK,
  RECALL_DEEP_POOL_SIZE,
  RECALL_POOL_SIZE,
  VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY,
} from "../constants";
import { isRerankMode, resolveConfig, type Config, type RerankMode } from "../config";
import { embed } from "../lib/ai";
import type { Identity } from "../lib/identity";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import { layerOf, scopeWhereForIdRead, scopeWhereForRead } from "../lib/scope";
import { expandGraph } from "../graph/traverse";
import type { GraphNeighbor } from "../graph/types";
import { KIND_VALUES, type MemoryKind } from "../memory/kind";
import { parseTimePhrase } from "../text/temporal";
import { CONTENT_LIKE_ESCAPE, contentLikePattern } from "../text/like";
import { distillToRareTerms, inferQueryTags, type DistilledQuery, type TimeBounds } from "./distill";
import { synthesizeInsight } from "./insight";
import { hasStaleAsOf } from "../memory/stale";
import { cosineSim, mmrRerank, rerankWithTimeDecay, type VectorizeMatch } from "./math";
import { rrfFuse } from "./rrf";
import { computeCompoundStale } from "./compound-stale";
import { exactQueryMatchCount, GRAPH_SLOT_INDEX, GRAPH_SLOT_INDICES, graphSeedLimit, lexicalSeedLimit, RECALL_SEED_TOPK, scoreLinkedEvidence } from "./neighborhood";
import { queryCoverage } from "./neighborhood";
import { buildQueryProfile, DEFAULT_EMBEDDING_QUERY_MODE, embeddingInput } from "./query-profile";
import { localEvidenceOf } from "./root-candidate";
import { blendRerankerScores, rerankStep } from "./model-reranker";
import { selectGraphRoots, type RootCandidate } from "./root-selector";
import type { KeywordRow, RecallDiagnostics, RecallInternalOptions, RecallMatch, RecallSearchResult, RecallStage } from "./types";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { projectFilterSql, projectMemberTags } from "../projects/filter";
import type { ProjectRow } from "../projects/registry";
import { workspaceFilter, queryVectorizeScoped } from "../vectorize/scope";
import { observeRecallEnv } from "./diagnostics";
import { chooseEvidenceSlot, type EvidenceSlotCandidate } from "./evidence-rescue";
import { queryRelevantWindow } from "./snippet";
import { FTS_LIVENESS_SQL, ftsEligibleToken, ftsMatchQuery, ftsReady, isFtsLiveRows } from "./fts";

async function keywordSearchLike(
  tokens: string[],
  env: Env,
  limit: number,
  bounds: Readonly<TimeBounds> = {},
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
): Promise<KeywordRow[]> {
  if (!tokens.length) return [];
  // Capped here rather than at distillation's uncapped exits because this is
  // the only place a token count becomes SQL, and there are two such exits —
  // one of which needs nothing worse than an empty corpus to fire (#276). Query
  // order is the only ordering available on those paths: they are exactly the
  // paths where the frequencies that would rank the terms are missing.
  const terms = tokens.slice(0, KEYWORD_MAX_TOKENS);
  const where = terms.map(() => `content LIKE ? ${CONTENT_LIKE_ESCAPE}`).join(" OR ");
  let timeWhere = "";
  const timeBindings: number[] = [];
  if (bounds.after !== undefined) {
    timeWhere += " AND created_at >= ?";
    timeBindings.push(bounds.after);
  }
  if (bounds.before !== undefined) {
    timeWhere += " AND created_at < ?";
    timeBindings.push(bounds.before);
  }
  // Scoped before ORDER BY so LIMIT ranks only readable rows, not readable rows
  // plus strangers' rows truncated by the window.
  const scope = identity ? scopeWhereForRead(identity, { layer: only, teamId }) : null;
  const scopeSql = scope ? ` AND ${scope.clause}` : "";
  // Keep the alternatives as one predicate whenever an AND filter follows.
  // Without grouping, SQLite applies that filter only to the final LIKE term
  // because AND binds more tightly than OR. Leave the unfiltered SQL unchanged.
  const tokenWhere = terms.length > 1 && (timeWhere || scopeSql) ? `(${where})` : where;
  const { results } = await env.DB.prepare(
    `SELECT id, content, tags, source, created_at FROM entries WHERE ${tokenWhere}${timeWhere}${scopeSql} ORDER BY created_at DESC LIMIT ?`
  ).bind(...terms.map(contentLikePattern), ...timeBindings, ...(scope?.bindings ?? []), limit).all();
  return results as unknown as KeywordRow[];
}

async function keywordSearchFts(
  match: string,
  env: Env,
  limit: number,
  bounds: Readonly<TimeBounds>,
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
): Promise<KeywordRow[]> {
  let timeWhere = "";
  const timeBindings: number[] = [];
  if (bounds.after !== undefined) { timeWhere += " AND e.created_at >= ?"; timeBindings.push(bounds.after); }
  if (bounds.before !== undefined) { timeWhere += " AND e.created_at < ?"; timeBindings.push(bounds.before); }
  const scope = identity ? scopeWhereForRead(identity, { layer: only, teamId }) : null;
  // workspace_id exists only on entries, not on entries_fts's id/content
  // columns, so the clause below resolves unambiguously though unqualified.
  const scopeSql = scope ? ` AND ${scope.clause}` : "";
  // Join on rowid as well as id: rowids are unique, so a stale duplicate FTS
  // row for one id cannot fill two LIMIT slots, and a drifted row (an FTS id
  // at a rowid whose entries.id differs) maps to nothing instead of a wrong entry.
  //
  // Write-path isolation v2.2 INVARIANT: FTS is live only if entries_fts
  // exists AND all three sync triggers exist. A hot-path repair can drop a
  // trigger without ever touching KV, leaving a table that still answers
  // MATCH queries — successfully, no exception — but has silently stopped
  // syncing. The liveness check rides in the SAME env.DB.batch() as the FTS
  // query (one subrequest, one extra statement) so that staleness is caught
  // structurally instead of relying on an error that never comes. Throwing
  // when not live reuses keywordSearch's existing catch-and-fall-back-to-LIKE
  // wiring below, rather than adding a second control path.
  const [livenessResult, ftsResult] = await env.DB.batch([
    // scope-exempt: FTS_LIVENESS_SQL reads sqlite_master (schema catalogue),
    // never entries/edges rows — nothing here to scope by workspace.
    env.DB.prepare(FTS_LIVENESS_SQL),
    // scope-checked: the caller's clause IS applied — scopeSql is built as ` AND ${scope.clause}` above and appended here; the lexer sees only the fragment name, and an allowlist on predicate position cannot see the leading AND inside it. Empty for an identity-less caller (pre-tenancy and unit fixtures), which is the pre-v3 whole-corpus keyword scan
    env.DB.prepare(
      `SELECT e.id, e.content, e.tags, e.source, e.created_at
       FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid AND e.id = entries_fts.id
       WHERE entries_fts MATCH ?${timeWhere}${scopeSql}
       ORDER BY bm25(entries_fts) LIMIT ?`
    ).bind(match, ...timeBindings, ...(scope?.bindings ?? []), limit),
  ]);
  if (!isFtsLiveRows(livenessResult.results as { name: string; sql: string | null }[] | undefined)) {
    throw new Error("entries_fts is not live (missing table, a sync trigger, or a trigger with an unexpected body)");
  }
  return ftsResult.results as unknown as KeywordRow[];
}

async function keywordSearch(
  tokens: string[],
  env: Env,
  limit: number,
  bounds: Readonly<TimeBounds> = {},
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
  // The corpus document frequencies distillToRareTerms already computed.
  // Absent (or null) on every path that skipped or lost that scan, in which
  // case the cost estimate below cannot run and routing keeps today's rules.
  corpus?: Pick<DistilledQuery, "df" | "total">,
): Promise<{ rows: KeywordRow[]; fts: boolean; route: RecallDiagnostics["ftsRoute"] }> {
  if (!tokens.length) return { rows: [], fts: false, route: "like-ineligible-token" };
  const terms = tokens.slice(0, KEYWORD_MAX_TOKENS);
  // ftsEligibleToken is the single source of truth: any token ftsMatchQuery
  // would drop means the match silently searches only the survivors and hides
  // entries matching just that one, so the whole query goes to LIKE.
  const match = ftsMatchQuery(terms);
  if (match && terms.every(ftsEligibleToken)) {
    // Cost-aware routing (T-0058): when distillation's frequency scan covers
    // every term, its df sum estimates exactly how many rows bm25 would have
    // to score. Past the budget, LIKE wins — it stops after KEYWORD_CANDIDATE_LIMIT
    // recency-ordered hits while bm25 scores every match. The scan counts the
    // deterministic variants retrieval appends too, so a plural query
    // ("widgets gadgets") estimates like its singular. Any term the scan still
    // lacks (cap-bound) keeps FTS, as does every single-word query: the distill
    // shortcut computes no df for one-word inputs, so single-word recall stays
    // on FTS by design.
    const df = corpus?.df;
    if (df && terms.every(t => df.has(t))) {
      const dfSum = terms.reduce((s, t) => s + (df.get(t) ?? 0), 0);
      if (dfSum > FTS_MATCH_BUDGET) {
        return { rows: await keywordSearchLike(tokens, env, limit, bounds, identity, only, teamId), fts: false, route: "like-match-budget" };
      }
    }
    if (await ftsReady(env)) {
      try {
        return { rows: await keywordSearchFts(match, env, limit, bounds, identity, only, teamId), fts: true, route: "fts" };
      } catch (e) {
        console.error("FTS keyword search failed (degrading to LIKE):", e);
        return { rows: await keywordSearchLike(tokens, env, limit, bounds, identity, only, teamId), fts: false, route: "like-error" };
      }
    }
    return { rows: await keywordSearchLike(tokens, env, limit, bounds, identity, only, teamId), fts: false, route: "like-not-ready" };
  }
  return { rows: await keywordSearchLike(tokens, env, limit, bounds, identity, only, teamId), fts: false, route: "like-ineligible-token" };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fuseDenseAndKeyword(
  denseMatches: VectorizeMatch[],
  keywordRows: KeywordRow[],
  tokens: string[],
  allowKeywordOnly: boolean,
  corpus: Pick<DistilledQuery, "df" | "total">,
  substringWeight: number,
  keywordPreRanked = false,
): VectorizeMatch[] {
  const denseByParent = new Map<string, VectorizeMatch>();
  for (const m of [...denseMatches].sort((a, b) => b.score - a.score)) {
    const pid = ((m.metadata as any)?.parentId ?? m.id) as string;
    if (!denseByParent.has(pid)) denseByParent.set(pid, m);
  }
  const denseRanked = [...denseByParent.keys()];

  const kwLower = keywordRows.map(r => ({ row: r, lc: r.content.toLowerCase() }));

  // Matched against lowercased content, so lowercased here too. Canonical
  // tokens already are; raw-surface probes (#326) arrive as typed.
  const needle = new Map(tokens.map(t => [t, t.toLowerCase()]));

  // IDF from the corpus-wide frequencies distillToRareTerms already computed,
  // when they cover every token; otherwise the old estimate from the fetched
  // rows. All-or-nothing rather than per-token, because the two denominators
  // (corpus size vs fetch-window size) are different scales — mixing them in
  // one weight sum would let the source of a token's IDF, not its rarity,
  // decide the ranking.
  let idf: (t: string) => number;
  if (corpus.df && corpus.total && tokens.every(t => corpus.df!.has(t))) {
    const { df, total } = corpus;
    idf = t => Math.log(1 + total / ((df.get(t) ?? 0) + 1));
  } else {
    const kwN = kwLower.length || 1;
    const kwDf = new Map(tokens.map(t => [t, kwLower.reduce((n, x) => n + (x.lc.includes(needle.get(t)!) ? 1 : 0), 0)]));
    idf = t => Math.log(1 + kwN / ((kwDf.get(t) ?? 0) + 1));
  }

  // A token found at a word boundary earns full IDF; found only inside a longer
  // word ("cat" in "concatenate") it earns a configured fraction. Lookarounds
  // rather than \b so identifier-shaped tokens ("#149", "v1.9") keep matching —
  // \b treats their punctuation as the boundary itself.
  const boundary = new Map(tokens.map(t => [t, new RegExp(`(?<![\\w])${escapeRegExp(needle.get(t)!)}(?![\\w])`)]));
  const tokenWeight = (lc: string, t: string) => {
    if (!lc.includes(needle.get(t)!)) return 0;
    return boundary.get(t)!.test(lc) ? idf(t) : idf(t) * substringWeight;
  };

  const keywordScored = kwLower
    .map(x => ({ row: x.row, weight: tokens.reduce((s, t) => s + tokenWeight(x.lc, t), 0) }))
    .filter(x => x.weight > 0 && (allowKeywordOnly || denseByParent.has(x.row.id)));
  // Combined review of Tasks 4-6 (FIX 3): the JS boundary/coverage weight is
  // the PRIMARY sort key in both paths. In the pre-ranked (FTS) path the
  // sort is weight-only and stable, so bm25's order survives WITHIN an
  // equal-weight tier — replacing the old recency tiebreak, which ranked a
  // long exact multi-token match behind every one-token note. The JS weight
  // still rides along as the RRF contribution weight — boundary and
  // coverage quality, which trigram bm25 cannot see.
  const keywordRanked = keywordPreRanked
    ? keywordScored.sort((a, b) => b.weight - a.weight)
    : keywordScored.sort((a, b) => b.weight - a.weight || b.row.created_at - a.row.created_at || (a.row.id < b.row.id ? -1 : 1));

  const fused = rrfFuse(denseRanked, keywordRanked.map(x => ({ id: x.row.id, weight: x.weight })));
  const keywordRowById = new Map(keywordRows.map(r => [r.id, r]));

  const out: VectorizeMatch[] = [];
  for (const [pid, score] of fused) {
    const dm = denseByParent.get(pid);
    if (dm) {
      out.push({ id: dm.id, score, metadata: dm.metadata, values: dm.values });
    } else {
      const r = keywordRowById.get(pid)!;
      out.push({ id: pid, score, metadata: { parentId: pid, created_at: r.created_at, tags: JSON.parse(r.tags ?? "[]"), content: r.content, source: r.source } });
    }
  }
  return out;
}

export async function recallEntries(
  params: { query: string; topK: number; tag?: string; after?: number; before?: number; kind?: MemoryKind; hops?: number; synthesize?: boolean; project?: readonly ProjectRow[] },
  env: Env,
  ctx: ExecutionContext,
  // Resolved once at request entry by the route/MCP caller and threaded down.
  // Optional so this stays callable without a config in tests and any future
  // internal caller; the fallback costs one KV read.
  config?: Readonly<Config>,
  internal: RecallInternalOptions = {},
): Promise<RecallSearchResult> {
  const totalStartedAt = performance.now();
  let stageStartedAt = totalStartedAt;
  const markStage = (stage: RecallStage) => {
    if (internal.diagnostics) {
      internal.diagnostics.stageMs ??= {};
      internal.diagnostics.stageMs[stage] = performance.now() - stageStartedAt;
    }
    stageStartedAt = performance.now();
  };
  if (internal.diagnostics) env = observeRecallEnv(env, internal.diagnostics);
  const cfg = config ?? await resolveConfig(env);
  const { query, topK } = params;
  const synthesize = params.synthesize ?? true;
  let { tag, after, before, kind } = params;
  // A project narrows exactly like a tag: candidates come from the members first (the tag
  // or any alias), and the same OR group is re-applied at hydration and in the JS re-check.
  const projectFilter = params.project?.length ? projectFilterSql(params.project) : null;
  const projectTags = projectMemberTags(params.project ?? []);
  const memberFirst = Boolean(tag) || projectFilter !== null;
  const hops = Math.max(0, Math.min(cfg.GRAPH_MAX_HOPS, params.hops ?? cfg.DEFAULT_HOPS));
  const now = Date.now();
  let semanticUnavailable = false;
  // One clause, computed once: every entries read below ANDs it in when an
  // Identity rides along, and appends nothing — byte for byte — when one does
  // not. workspaceFilter and teamId narrow the same clause further.
  const readScope = internal.identity
    ? { layer: internal.workspaceFilter, teamId: internal.teamId }
    : undefined;
  const scope = readScope ? scopeWhereForRead(internal.identity!, readScope) : null;
  const identity = internal.identity;
  const requestedArms = internal.variant?.arms;
  if (requestedArms !== undefined && requestedArms !== "both" && requestedArms !== "dense-only" && requestedArms !== "keyword-only") {
    throw new Error(`Unknown recall variant arms: ${String(requestedArms)}`);
  }
  const arms = memberFirst ? "both" : requestedArms ?? "both";

  let semanticQuery = query;
  if (after === undefined && before === undefined) {
    const parsed = parseTimePhrase(query, now);
    after = parsed.after;
    before = parsed.before;
    semanticQuery = parsed.cleanQuery;
  }
  const bounds = { after, before };
  const distilled = await distillToRareTerms(semanticQuery, env, cfg, bounds, identity, internal.workspaceFilter, internal.teamId);
  const profile = buildQueryProfile(semanticQuery, distilled);
  const embeddingQueryMode = internal.embeddingQueryMode ?? DEFAULT_EMBEDDING_QUERY_MODE;
  const embedQuery = embeddingInput(profile, embeddingQueryMode);
  const lexicalQuery = profile.lexicalQuery;
  if (internal.diagnostics) {
    internal.diagnostics.embeddingMode = embeddingQueryMode;
    // #326 visibility: an empty keywordIds used to be indistinguishable from
    // "the lexical arm never ran".
    internal.diagnostics.retrievalTokenCount = profile.retrievalTokens.length;
    internal.diagnostics.lexicalArmSkipped = profile.retrievalTokens.length === 0;
    internal.diagnostics.corpusIdfUsed = !!distilled.df && !!distilled.total
      && profile.lexicalTokens.every(t => distilled.df!.has(t));
    internal.diagnostics.distillSource = distilled.distillSource;
  }
  markStage("setup");

  const tokens = profile.lexicalTokens;
  const [values, queryTags] = await Promise.all([
    arms === "keyword-only" ? Promise.resolve([] as number[]) : embed(embedQuery, env, cfg),
    inferQueryTags(lexicalQuery, env, ctx, identity),
  ]);
  markStage("querySignals");

  let keywordRows: KeywordRow[] = [];
  let ftsServedKeywords = false; // memberFirst never sets this: tag rows are not bm25-ordered
  let results: { matches: VectorizeMatch[] };
  // Deeper dense results, fetched only when the diversified list is shorter than topK (see the fill below).
  let denseFill: (() => Promise<VectorizeMatch[]>) | undefined;
  if (memberFirst) {
    // Tag/project recalls never run keywordSearch (tag rows are not bm25-
    // ordered), so name the route here: ftsRoute is set on every recall path.
    // Initialized before any early return below (FIX 2, final review), so a
    // "no member rows at all" return leaves diagnostics in the same shape
    // every other path does, instead of undefined.
    if (internal.diagnostics) {
      internal.diagnostics.ftsRoute = "like-member-first";
      internal.diagnostics.ftsUsed = false;
      internal.diagnostics.keywordIds = [];
    }
    // Escaped: a tag is user data and LIKE reads _ and % as wildcards. This is a read, so
    // the failure is over-broad results rather than the permanent rollup the same bug
    // caused in compressTag — but `?tag=%` silently defeats the filter entirely and
    // returns the whole brain, which is not a recoverable-looking answer either.
    const tagScopeSql = scope ? ` AND ${scope.clause}` : "";
    const memberConds: string[] = [];
    const memberBindings: string[] = [];
    if (tag) { memberConds.push(`tags LIKE ? ${TAG_LIKE_ESCAPE}`); memberBindings.push(tagLikePattern(tag)); }
    if (projectFilter) { memberConds.push(projectFilter.clause); memberBindings.push(...projectFilter.bindings); }
    // scope-checked: the caller's clause IS applied — tagScopeSql is built as ` AND ${scope.clause}` above and appended here; the lexer sees only the fragment name, and an allowlist on predicate position cannot see the leading AND inside it. Empty for an identity-less caller (pre-tenancy and unit fixtures), which is the pre-v3 whole-corpus tag scan
    const { results: tagRows } = await env.DB.prepare(
      `SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE ${memberConds.join(" AND ")}${tagScopeSql}`
    ).bind(...memberBindings, ...(scope?.bindings ?? [])).all();
    if (!tagRows.length) return { matches: [], insight: "", semanticUnavailable };
    keywordRows = tagRows as unknown as KeywordRow[];

    const vectorIds = [...new Set(
      (tagRows as any[]).flatMap(r => JSON.parse((r.vector_ids as string) ?? "[]") as string[])
    )];

    const vectors: VectorizeVector[] = [];
    if (!vectorIds.length) {
      // No member row carries a vector yet. Mirror the non-memberFirst
      // path's Vectorize-unavailable degrade (FIX 2, final review): continue
      // with empty dense results and allow keyword-only fusion below,
      // instead of dropping an exact keyword match that simply has no
      // embedding.
      semanticUnavailable = true;
    } else {
      try {
        for (let i = 0; i < vectorIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
          vectors.push(...await env.VECTORIZE.getByIds(vectorIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH)));
        }
      } catch (e) {
        console.error("Vectorize getByIds failed (degrading to keyword-only):", e);
        semanticUnavailable = true;
      }
    }

    results = {
      matches: vectors.map(v => ({
        id: v.id,
        score: cosineSim(values, v.values as number[]),
        metadata: v.metadata,
        values: v.values as number[],
      })) as VectorizeMatch[],
    };
  } else {
    // A fixed pool, so a larger topK only extends the list and never reorders its head.
    const vectorizeTopK = RECALL_POOL_SIZE;
    // Scoped when an Identity is in play: the workspace filter keeps foreign
    // candidates out of the result slots. queryVectorizeScoped retries
    // unfiltered if Vectorize rejects the filter; hydration below is scoped at
    // the SQL layer either way, so correctness never rides on this.
    const wsFilter = identity ? workspaceFilter(identity, internal.workspaceFilter, internal.teamId)?.filter : undefined;
    // env-free code (src/vectorize/scope.ts) cannot reach KV itself, so the
    // caller hands it this callback. It fires at most once per isolate — see
    // queryVectorizeScoped's own transition guard — so it cannot move
    // recall-free-tier-budget, which never rejects a filter.
    const onDegrade = () => ctx.waitUntil(
      env.OAUTH_KV.put(VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY, String(Date.now()))
        .catch((e: unknown) => console.error("Vectorize filter-degradation marker write failed (non-fatal):", e)),
    );
    const denseAt = async (k: number): Promise<{ matches: VectorizeMatch[] }> => {
      if (wsFilter) {
        const { matches } = await queryVectorizeScoped<VectorizeMatch>(
          env.VECTORIZE, values, { topK: k, filter: wsFilter, onDegrade },
        );
        return { matches };
      }
      return await env.VECTORIZE.query(values, { topK: k, returnMetadata: "all", returnValues: true });
    };
    const denseQuery = async (): Promise<{ matches: VectorizeMatch[] }> => {
      if (arms === "keyword-only") return { matches: [] as VectorizeMatch[] };
      try {
        return await denseAt(vectorizeTopK);
      } catch (e) {
        console.error("Vectorize query failed (degrading to keyword-only):", e);
        semanticUnavailable = true;
        return { matches: [] as VectorizeMatch[] };
      }
    };
    const [denseResults, kw] = await Promise.all([
      denseQuery(),
      arms === "dense-only"
        ? Promise.resolve({ rows: [] as KeywordRow[], fts: false, route: "skipped-by-variant" as const })
        : keywordSearch(profile.retrievalTokens, env, cfg.KEYWORD_CANDIDATE_LIMIT, bounds, identity, internal.workspaceFilter, internal.teamId, distilled),
    ]);
    results = denseResults;
    keywordRows = kw.rows;
    ftsServedKeywords = kw.fts;
    if (internal.diagnostics) internal.diagnostics.ftsRoute = kw.route;

    // Governed by its own threshold, not the write-path duplicate flag: the two
    // shared a constant until #245, so retuning duplicate detection silently
    // retuned recall widening.
    if (!semanticUnavailable && results.matches.length && results.matches[0].score < cfg.RECALL_WIDEN_THRESHOLD) {
      try {
        results = await denseAt(RECALL_DEEP_POOL_SIZE);
      } catch (e) {
        console.error("Vectorize widen-query failed (non-fatal, keeping narrow results):", e);
      }
    }
    // A full pool means the index has more to give. Already widened: the deep list is in hand.
    if (!semanticUnavailable && results.matches.length >= vectorizeTopK) {
      const have = results.matches.length > vectorizeTopK ? results.matches : undefined;
      denseFill = async () => have ?? (await denseAt(RECALL_DEEP_POOL_SIZE)).matches;
    }
  }

  if (internal.diagnostics) {
    internal.diagnostics.denseIds = [...new Set(results.matches.map(m => ((m.metadata as any)?.parentId ?? m.id) as string))];
    internal.diagnostics.keywordIds = [...new Set(keywordRows.map(row => row.id))];
    internal.diagnostics.ftsUsed = ftsServedKeywords;
  }
  markStage("candidateGeneration");

  const semanticRankByParent = new Map<string, number>();
  [...results.matches]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .forEach(match => {
      const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
      if (!semanticRankByParent.has(parentId)) semanticRankByParent.set(parentId, semanticRankByParent.size + 1);
    });

  const keywordPreRanked = internal.keywordPreRankedOverride ?? ftsServedKeywords;
  const rootFusedMatches = fuseDenseAndKeyword(results.matches as VectorizeMatch[], keywordRows, profile.retrievalTokens, !memberFirst || semanticUnavailable, distilled, cfg.SUBSTRING_MATCH_WEIGHT, keywordPreRanked);
  const lexicalFusedMatches = fuseDenseAndKeyword(results.matches as VectorizeMatch[], keywordRows, tokens, !memberFirst || semanticUnavailable, distilled, cfg.SUBSTRING_MATCH_WEIGHT, keywordPreRanked);
  const fusedMatches = lexicalFusedMatches.length ? lexicalFusedMatches : rootFusedMatches;
  if (!rootFusedMatches.length && !fusedMatches.length) return { matches: [], insight: "", semanticUnavailable };

  const candidateIds = [...new Set([...fusedMatches, ...rootFusedMatches].map(m => (m.metadata as any)?.parentId ?? m.id))] as string[];
  internal.diagnostics && (internal.diagnostics.fusedIds = [...new Set(rootFusedMatches.map(m => (m.metadata as any)?.parentId ?? m.id))] as string[]);
  type CandidateSignalRow = { id: string; content?: string; source?: string; created_at?: number; last_updated?: number; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number; tags: string };
  const rcRows: CandidateSignalRow[] = [];
  const candidateSignalProjection = hops > 0
    ? `id, content, source, created_at, COALESCE(updated_at, created_at) AS last_updated, recall_count, importance_score, contradiction_wins, contradiction_losses, tags, workspace_id, actor_id`
    : "id, recall_count, importance_score, contradiction_wins, contradiction_losses, tags, workspace_id, actor_id";
  // Scoped too: this is the leak-catcher for unscoped Vectorize hits — until
  // namespaces land (P3) the dense arm can surface a stranger's id, and the
  // scope clause here is what stops that id from hydrating into signals. The
  // scope's two bindings count toward D1's bound-parameter ceiling exactly as
  // the ids do, so the batch shrinks by them rather than overrunning.
  const rcScopeSql = scope ? ` AND ${scopeWhereForIdRead(scope).clause}` : "";
  const rcBatchSize = D1_MAX_BOUND_PARAMS - (scope?.bindings.length ?? 0);
  for (let i = 0; i < candidateIds.length; i += rcBatchSize) {
    const batch = candidateIds.slice(i, i + rcBatchSize);
    const rcPlaceholders = batch.map(() => "?").join(", ");
    // scope-checked: rcScopeSql applies the caller's clause through scopeWhereForIdRead above; the lexer cannot see the leading AND inside that JS fragment. Empty only for an identity-less caller
    const { results: rows } = await env.DB.prepare(
      `SELECT ${candidateSignalProjection} FROM entries WHERE id IN (${rcPlaceholders})${rcScopeSql}`
    ).bind(...batch, ...(scope?.bindings ?? [])).all() as { results: CandidateSignalRow[] };
    rcRows.push(...rows);
  }
  const recallCounts = new Map(rcRows.map(r => [r.id, r.recall_count ?? 0]));
  const importanceScores = new Map(rcRows.map(r => [r.id, r.importance_score ?? 0]));
  const contradictionWins = new Map(rcRows.map(r => [r.id, r.contradiction_wins ?? 0]));
  const contradictionLosses = new Map(rcRows.map(r => [r.id, r.contradiction_losses ?? 0]));
  const d1Tags = new Map(rcRows.map(r => [r.id, JSON.parse(r.tags ?? "[]") as string[]]));

  let directReranked = rerankWithTimeDecay(fusedMatches, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses, d1Tags, cfg);
  // The root view is computed here, beside the direct one, so a single model batch can cover both.
  let rootReranked = hops > 0
    ? rerankWithTimeDecay(rootFusedMatches, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses, d1Tags, cfg, { useRecallFrequency: false })
    : [];
  const rerankMode: RerankMode = internal.variant?.rerank === true ? "on" : internal.variant?.rerank === false ? "off" : isRerankMode(cfg.RERANK_MODE) ? cfg.RERANK_MODE : "off";
  // Only parents the scoped D1 read returned may reach the model: a foreign Vectorize hit has no row here.
  const scopedParents = new Set(rcRows.map(r => r.id));
  const inScope = (m: VectorizeMatch) => scopedParents.has(((m.metadata as any)?.parentId ?? m.id) as string);
  const rerank = await rerankStep({
    mode: rerankMode, forced: internal.variant?.rerank === true, tuning: internal.variant?.rerankTuning, env, ctx, query: semanticQuery,
    queryTokens: profile.evidenceTokens, evidenceTokens: profile.evidenceTokens, direct: directReranked.filter(inScope), root: rootReranked.filter(inScope),
    loadContent: async ids => {
      const known = new Map(rcRows.filter(r => r.content !== undefined).map(r => [r.id, r.content as string]));
      const need = ids.filter(id => !known.has(id) && scopedParents.has(id));
      if (need.length) {
        // scope-exempt: by-id: every id here came from rcRows, the scoped candidate-signal read above (inScope filters to it). The scope clause is left out on purpose: with it SQLite plans a scan of the caller's whole workspace instead of <=30 primary-key lookups, which costs rows_read in proportion to the brain's size on every recall
        const { results } = await env.DB.prepare(
          `SELECT id, content FROM entries WHERE id IN (${need.map(() => "?").join(", ")})`
        ).bind(...need).all() as { results: { id: string; content: string }[] };
        for (const r of results) known.set(r.id, r.content);
      }
      return known;
    },
  });
  if (internal.diagnostics) {
    internal.diagnostics.rerankRoute = rerank.route;
    if (rerank.ms !== undefined) internal.diagnostics.rerankMs = rerank.ms;
  }
  // Linked-evidence scoring is calibrated on heuristic root scores; a reranker blend rescales them (best x2, worst x0.25),
  // which would move which linked memories qualify even when the model agrees with the heuristic order. Keep the
  // pre-blend scores for it; the blend still decides the ORDER of the direct picks and of root selection.
  const parentOfMatch = (m: VectorizeMatch) => ((m.metadata as any)?.parentId ?? m.id) as string;
  const heuristicDirectScore = new Map<string, number>();
  for (const m of directReranked) if (!heuristicDirectScore.has(parentOfMatch(m))) heuristicDirectScore.set(parentOfMatch(m), m.score);
  const heuristicRootScore = new Map<string, number>();
  for (const m of rootReranked) if (!heuristicRootScore.has(parentOfMatch(m))) heuristicRootScore.set(parentOfMatch(m), m.score);
  if (rerank.percentiles) {
    directReranked = blendRerankerScores(directReranked, rerank.percentiles, internal.variant?.rerankTuning?.weight, internal.variant?.rerankTuning?.floor);
    rootReranked = blendRerankerScores(rootReranked, rerank.percentiles, internal.variant?.rerankTuning?.weight, internal.variant?.rerankTuning?.floor);
  }
  internal.diagnostics && (internal.diagnostics.candidateIds = directReranked.map(m => ((m.metadata as any)?.parentId ?? m.id) as string));

  const seen = new Set<string>();
  const dedupedAll = directReranked.filter((m) => {
    const parentId = (m.metadata as any)?.parentId ?? m.id;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    return true;
  });
  // MMR is greedy, so its first n picks do not depend on how many are asked for. Rounding the depth up to whole
  // blocks (each ordered by score below) keeps every block a topK cuts the same block a larger topK sees, and a
  // default topK 5 call diversifies and hydrates exactly the five it always did.
  const directCandidates = mmrRerank(dedupedAll, cfg.MMR_LAMBDA, Math.ceil(topK / RECALL_BLOCK) * RECALL_BLOCK);
  // A topK larger than the diversified list draws the rest from a deeper dense list, after everything above. The
  // fetch happens only then, but what it adds is the same whatever topK is, and it only ever follows the list, so the
  // head of a smaller topK is a prefix of it.
  const parentOf = (m: VectorizeMatch) => ((m.metadata as any)?.parentId ?? m.id) as string;
  let fillCandidates: VectorizeMatch[] = [];
  if (denseFill && topK > directCandidates.length) {
    try {
      const taken = new Set(directCandidates.map(parentOf));
      fillCandidates = (await denseFill()).filter(m => !taken.has(parentOf(m)) && taken.add(parentOf(m)));
    } catch (e) {
      console.error("Vectorize deep query failed (non-fatal, returning the shorter list):", e);
    }
  }
  markStage("candidateHydration");

  if (!directCandidates.length) return { matches: [], insight: "", semanticUnavailable };

  const directParentIds = directCandidates.map((m) => (m.metadata as any)?.parentId ?? m.id);
  let selectedRoots: ReturnType<typeof selectGraphRoots> = [];
  let rootCandidates: RootCandidate[] = [];
  if (hops > 0) {
    const candidateContent = new Map(rcRows.map(r => [r.id, r.content ?? ""]));
    const rootSeen = new Set<string>();
    rootCandidates = rootReranked.flatMap(match => {
      const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
      if (rootSeen.has(parentId)) return [];
      rootSeen.add(parentId);
      const tags = d1Tags.get(parentId) ?? [];
      const localEvidence = localEvidenceOf(match, candidateContent.get(parentId) ?? "", tokens);
      const tagAlignment = queryTags.length ? tags.filter(value => queryTags.includes(value)).length / queryTags.length : 0;
      const episodicAlignment = ["causal", "chronology"].includes(profile.intent) && tags.includes("kind:episodic") ? 1 : 0;
      const authorityAlignment = ["current", "direct"].includes(profile.intent) && tags.includes("status:canonical") ? 1 : 0;
      return [{ ...match, parentId, rootScore: match.score, evidenceScore: heuristicRootScore.get(parentId) ?? match.score, localEvidence, tags,
        lexicalCoverage: queryCoverage(localEvidence, tokens, distilled).score,
        metadataAlignment: Math.min(1, .6 * tagAlignment + .2 * episodicAlignment + .2 * authorityAlignment),
        semanticRank: semanticRankByParent.get(parentId) }];
    });
    // The seat budgets are sized for RECALL_SEED_TOPK, not the caller's topK, so a larger topK cannot change which
    // roots are seeded (and with them the head).
    // One selection per arm, against that arm's own budget: a row the dense arm
    // never returned has no semantic rank, so it cannot take a seat — or a seat
    // in the "semantic" view — from a row that does. The keyword arm still gets
    // the window back when the dense arm does not fill it (lexicalSeedLimit), so
    // a recall with Vectorize down is seeded from as many roots as a healthy one.
    //
    // The second pass labels its picks with the same RootView names, so a
    // keyword-only row can be tagged selectedBy "semantic" — it topped its own
    // partition's rootScore order, which for these rows IS the keyword order.
    // Nothing reads the label as proof of a dense rank: the one consumer,
    // chooseEvidenceSlot's semantic branch, tests semanticRank !== undefined as
    // well, which no row in this partition has.
    const denseRoots = rootCandidates.filter(root => root.semanticRank !== undefined);
    const lexicalRoots = rootCandidates.filter(root => root.semanticRank === undefined);
    const scopeBindings = scope?.bindings.length ?? 0;
    const denseSeats = graphSeedLimit(RECALL_SEED_TOPK, denseRoots.length, scopeBindings);
    selectedRoots = [
      ...selectGraphRoots(denseRoots, denseSeats, cfg.MMR_LAMBDA),
      ...selectGraphRoots(lexicalRoots, lexicalSeedLimit(RECALL_SEED_TOPK, lexicalRoots.length, denseSeats, scopeBindings), cfg.MMR_LAMBDA),
    ];
  }
  const graphSeedIds = selectedRoots.map(x => x.candidate.parentId);
  if (internal.diagnostics && hops > 0) {
    internal.diagnostics.rootSelections = selectedRoots.map(x => ({ id: x.candidate.parentId, selectedBy: x.selectedBy }));
    internal.diagnostics.rejections = [];
  }

  let expanded: GraphNeighbor[] = [];
  if (hops > 0) {
    expanded = await expandGraph(graphSeedIds, { hops, only: internal.workspaceFilter, teamId: internal.teamId }, env, cfg, identity);
  }
  markStage("graphExpansion");
  if (internal.diagnostics && hops > 0) internal.diagnostics.expandedIds = expanded.map(x => x.id);

  // The graph view can include up to 50 roots and 50 expanded nodes in addition
  // to direct candidates. Keep the union unique and chunked: with a topK above
  // the public route's cap this can span multiple D1 statements, and time
  // filters consume bindings in every statement.
  const allParentIds = [...new Set([
    ...directParentIds,
    ...fillCandidates.map(parentOf),
    ...graphSeedIds,
    ...expanded.map(e => e.id),
  ])];
  let d1Filters = ` AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"auto-insight"%' AND tags NOT LIKE '%"status:deprecated"%'`;
  const filterBindings: (string | number)[] = [];
  if (tag) {
    d1Filters += ` AND tags LIKE ? ${TAG_LIKE_ESCAPE}`;
    filterBindings.push(tagLikePattern(tag));
  }
  if (projectFilter) {
    d1Filters += ` AND ${projectFilter.clause}`;
    filterBindings.push(...projectFilter.bindings);
  }
  if (kind && (KIND_VALUES as readonly string[]).includes(kind)) {
    d1Filters += ` AND tags LIKE '%"kind:${kind}"%'`;
  }
  if (after !== undefined) { d1Filters += ` AND created_at >= ?`; filterBindings.push(after); }
  if (before !== undefined) { d1Filters += ` AND created_at < ?`; filterBindings.push(before); }
  // Last filter in, so the scope's bindings are already inside filterBindings
  // when idBatchSize subtracts them from the bound-parameter ceiling — the same
  // accounting every other filter's bindings get.
  if (scope) {
    d1Filters += ` AND ${scopeWhereForIdRead(scope).clause}`;
    filterBindings.push(...scope.bindings);
  }
  const d1Rows: Record<string, any>[] = [];
  const idBatchSize = D1_MAX_BOUND_PARAMS - filterBindings.length;
  for (let i = 0; i < allParentIds.length; i += idBatchSize) {
    const batch = allParentIds.slice(i, i + idBatchSize);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      // scope-checked: d1Filters applies scopeWhereForIdRead(scope) above; the lexer cannot see the leading AND inside that JS fragment
      `SELECT id, content, tags, source, created_at, updated_at, workspace_id, actor_id FROM entries WHERE id IN (${placeholders})${d1Filters}`
    ).bind(...batch, ...filterBindings).all() as { results: Record<string, any>[] };
    d1Rows.push(...results);
  }

  const d1Map = new Map(d1Rows.map((r) => [r.id as string, r]));
  // Which layer a memory lives in, resolved against the caller's own workspace
  // ids: personal and company map to themselves, anything else ('' legacy rows,
  // system insights) reads as "system". Clients use this to offer share/unshare
  // and to badge results.
  const candidateSignalById = new Map(rcRows.map(row => [row.id, row]));
  markStage("finalHydration");

  // Blocks of five in MMR order, each ordered by score: the first block is what a topK 5 call always returned, and a
  // later block only depends on the picks before it, so no topK can reorder a block it does not cut.
  const pickBlocks = Array.from({ length: Math.ceil(directCandidates.length / RECALL_BLOCK) }, (_, b) =>
    directCandidates.slice(b * RECALL_BLOCK, (b + 1) * RECALL_BLOCK).sort((a, c) => c.score - a.score));
  const directMatchOf = (m: VectorizeMatch, score: number): RecallMatch[] => {
    const meta = m.metadata as Record<string, any>;
    const parentId = (meta?.parentId ?? m.id) as string;
    const row = d1Map.get(parentId);
    if (!row) return [];
    return [{
      id: parentId,
      content: row.content as string,
      score,
      createdAt: row.created_at as number,
      updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      isUpdate: !!meta?.isUpdate,
      hop: 0,
      workspace: layerOf(identity, row.workspace_id),
      staleAsOf: hasStaleAsOf(JSON.parse(row.tags ?? "[]")),
    }];
  };
  // The direct matches that hydrated, per block. Every position below is decided against these blocks and the picks
  // that made them, never against how many of them survived, and only a topK past the last block can add one.
  const blockMatches = pickBlocks.map(block => block.flatMap(m => directMatchOf(m, m.score)));
  const directMatches: RecallMatch[] = blockMatches.flat();
  // The deeper matches rank below everything above, in dense order, so their scores step down from the lowest.
  const fillFloor = directMatches.length ? Math.min(...directMatches.map(m => m.score)) : 0;
  const fillMatches = fillCandidates.flatMap((m, i) => directMatchOf(m, fillFloor * (1 - 0.01 * (i + 1))));

  // Linked memories compete with the leading picks only (first block; first two for the second slot), whatever topK
  // is. They are the picks, not the survivors: a pick that did not hydrate cannot be a linked memory either.
  const headParentIds = directParentIds.slice(0, RECALL_BLOCK);
  const leadingParentIds = directParentIds.slice(0, 2 * RECALL_BLOCK);
  const maximumRootScore = Math.max(...selectedRoots.map(x => x.candidate.evidenceScore ?? x.candidate.rootScore));
  const normalizedRootDivisor = maximumRootScore > 0 ? maximumRootScore : 1;
  const rootById = new Map(selectedRoots.map(x => [x.candidate.parentId, x.candidate]));
  const rootIdByNode = new Map(selectedRoots.map(x => [x.candidate.parentId, x.candidate.parentId]));
  const fallbackDirect = directCandidates[Math.min(directCandidates.length, RECALL_BLOCK) - 1];
  const fallbackRootScore = fallbackDirect ? heuristicDirectScore.get(parentOfMatch(fallbackDirect)) ?? fallbackDirect.score : 0;
  for (const e of expanded) {
    rootIdByNode.set(e.id, rootIdByNode.get(e.viaFrom) ?? e.viaFrom);
  }
  const replacement = blockMatches[0]?.[GRAPH_SLOT_INDEX];
  const replacementCoverage = replacement ? Math.max(
    queryCoverage(replacement.content, tokens, distilled).score,
    queryCoverage(replacement.content, profile.evidenceTokens, distilled).score,
  ) : 0;
  const expandedMatches: { match: RecallMatch; eligible: boolean; evidenceText: string; coverage: number }[] = expanded.flatMap((e) => {
    const row = d1Map.get(e.id);
    if (!row) return [];
    const root = rootById.get(rootIdByNode.get(e.id) ?? "");
    const rootScore = root ? (root.evidenceScore ?? root.rootScore) / normalizedRootDivisor : fallbackRootScore;
    const evidence = scoreLinkedEvidence({
      parentScore: rootScore,
      parentContent: root?.localEvidence ?? "",
      content: row.content as string,
      queryTokens: tokens,
      evidenceTokens: profile.evidenceTokens,
      corpus: distilled,
      hop: e.hop,
      edgeWeight: e.viaWeight,
      provenance: e.viaProvenance,
      hopDecay: cfg.GRAPH_HOP_DECAY,
      replacementCoverage,
      intent: profile.intent,
      edgeType: e.viaType,
    });
    if (!evidence.eligible) internal.diagnostics?.rejections?.push({ id: e.id, reason: evidence.rejection ?? "weak-neighborhood" });
    const linkedEvidence = queryRelevantWindow(
      row.content as string,
      [...tokens, ...profile.evidenceTokens],
    );
    const evidenceText = `${root?.localEvidence ?? ""}\n${linkedEvidence}`;
    const coverage = queryCoverage(evidenceText, profile.evidenceTokens, distilled).score;
    return [{
      eligible: evidence.eligible,
      evidenceText,
      coverage,
      match: {
        id: e.id,
        content: row.content as string,
        score: evidence.score,
        createdAt: row.created_at as number,
        updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
        tags: JSON.parse(row.tags ?? "[]"),
        source: row.source as string,
        isUpdate: false,
        hop: e.hop,
        workspace: layerOf(identity, row.workspace_id),
        staleAsOf: hasStaleAsOf(JSON.parse(row.tags ?? "[]")),
        viaProvenance: e.viaProvenance,
        viaType: e.viaType,
        viaLinkedAt: e.viaLinkedAt,
        viaFrom: e.viaFrom,
      },
    }];
  });

  const sortedExpanded = expandedMatches
    .sort((a, b) => b.match.score - a.match.score || a.match.id.localeCompare(b.match.id));
  if (internal.diagnostics) {
    internal.diagnostics.eligibleRelatedIds = sortedExpanded
      .filter(entry => entry.eligible && !headParentIds.includes(entry.match.id))
      .map(entry => entry.match.id);
  }
  // The first linked memory must be outside the first block of picks; the second outside the first two.
  const eligibleRelated = sortedExpanded.filter(e => e.eligible && !headParentIds.includes(e.match.id)).map(e => e.match);
  const selectedRelated = [
    ...eligibleRelated.slice(0, 1),
    ...eligibleRelated.slice(1).filter(match => !leadingParentIds.includes(match.id)).slice(0, GRAPH_SLOT_INDICES.length - 1),
  ];
  const [firstRelated, secondRelated] = selectedRelated;
  const [block1 = [], block2 = [], ...laterBlocks] = blockMatches;
  // The list is laid out block by block and cut to topK at the end:
  //  - the window is exactly what a topK 5 call returns: the first block's survivors with the first linked memory in
  //    the fifth place (or the fifth survivor when there is none);
  //  - the second block follows, with the second linked memory at rank 10 (or after the block's last item when it
  //    ends sooner); a linked memory is placed against the blocks, never against how many of their picks survived;
  //  - later blocks follow, and everything a deeper dense query adds follows them.
  // A topK past a block only adds that block after everything above it, so a larger topK only appends.
  const baselineMatches: RecallMatch[] = [...block1.slice(0, firstRelated ? GRAPH_SLOT_INDEX : GRAPH_SLOT_INDEX + 1), ...(firstRelated ? [firstRelated] : [])];
  let window: RecallMatch[] = baselineMatches;
  // A direct match the evidence slot pushed out, to be shown where the chosen match used to sit if that was further down.
  let displaced: RecallMatch | undefined;
  if (hops > 0 && baselineMatches.length > GRAPH_SLOT_INDEX) {
    const replacementIndex = GRAPH_SLOT_INDEX;
    const replacementMatch = baselineMatches[replacementIndex];
    const replacementEvidence = queryCoverage(
      replacementMatch.content,
      profile.evidenceTokens,
      distilled,
    ).score;
    const protectedIds = new Set(baselineMatches.slice(0, replacementIndex).map(match => match.id));
    const matchById = new Map<string, RecallMatch>();
    const candidates: EvidenceSlotCandidate[] = [];
    const selectedRootIds = new Set(selectedRoots.map(selection => selection.candidate.parentId));
    const omittedChallenger = rootCandidates
      .filter(root => !selectedRootIds.has(root.parentId) && !headParentIds.includes(root.parentId))
      .filter(root => root.semanticRank !== undefined)
      .sort((a, b) => a.semanticRank! - b.semanticRank!
        || b.rootScore - a.rootScore
        || a.parentId.localeCompare(b.parentId))[0];
    const rootsForEvidence = [
      ...selectedRoots.map(selection => ({ root: selection.candidate, semanticEligible: selection.selectedBy === "semantic" })),
      ...(omittedChallenger ? [{ root: omittedChallenger, semanticEligible: true }] : []),
    ];

    for (const { root, semanticEligible } of rootsForEvidence) {
      if (headParentIds.includes(root.parentId) || protectedIds.has(root.parentId)) continue;
      const row = d1Map.get(root.parentId) ?? candidateSignalById.get(root.parentId);
      if (!row) continue;
      const rowTags = JSON.parse(row.tags ?? "[]") as string[];
      const normalizedRowTags = rowTags.map(value => value.toLowerCase());
      if (normalizedRowTags.some(value => ["auto-pattern", "auto-insight", "status:deprecated"].includes(value))) continue;
      if (tag && !normalizedRowTags.includes(tag.toLowerCase())) continue;
      if (projectFilter && !normalizedRowTags.some(value => projectTags.has(value))) continue;
      if (kind && !rowTags.includes(`kind:${kind}`)) continue;
      if (after !== undefined && Number(row.created_at) < after) continue;
      if (before !== undefined && Number(row.created_at) >= before) continue;
      const supplemental = queryCoverage(root.localEvidence, profile.evidenceTokens, distilled);
      const match: RecallMatch = {
        id: root.parentId,
        content: row.content as string,
        score: root.rootScore,
        createdAt: row.created_at as number,
        updatedAt: "last_updated" in row
          ? row.last_updated as number
          : ((row as Record<string, any>).updated_at as number | null) ?? (row.created_at as number),
        tags: rowTags,
        source: row.source as string,
        isUpdate: false,
        hop: 0,
        workspace: layerOf(identity, (row as Record<string, unknown>).workspace_id),
        staleAsOf: hasStaleAsOf(rowTags),
      };
      matchById.set(match.id, match);
      candidates.push({
        id: match.id,
        coverage: supplemental.score,
        exactHighIdf: supplemental.exactHighIdf,
        exactMatchCount: exactQueryMatchCount(root.localEvidence, profile.evidenceTokens),
        metadataAlignment: root.metadataAlignment,
        score: root.rootScore,
        source: "omitted-root",
        semanticRank: root.semanticRank,
        semanticEligible,
        lexicalOnly: root.semanticRank === undefined,
      });
    }

    for (const entry of sortedExpanded) {
      if (!entry.eligible || protectedIds.has(entry.match.id) || headParentIds.includes(entry.match.id)) continue;
      const precision = queryCoverage(entry.evidenceText, profile.evidenceTokens, distilled);
      matchById.set(entry.match.id, entry.match);
      candidates.push({
        id: entry.match.id,
        coverage: entry.coverage,
        exactHighIdf: precision.exactHighIdf,
        exactMatchCount: exactQueryMatchCount(entry.evidenceText, profile.evidenceTokens),
        metadataAlignment: 0,
        score: entry.match.score,
        source: "related",
      });
    }

    const chosen = chooseEvidenceSlot({
      coverage: replacementEvidence,
      semanticRank: semanticRankByParent.get(replacementMatch.id),
      semanticAllowed: replacementMatch.hop === 0,
    }, candidates);
    const chosenMatch = chosen && matchById.get(chosen.id);
    if (chosenMatch) {
      window = [...baselineMatches.slice(0, replacementIndex), chosenMatch];
      if (replacementMatch.hop === 0) displaced = replacementMatch;
    }
  }
  const taken = new Set(window.map(match => match.id));
  // One pass over what follows the window: drop what the window already shows (it moved up), and put the direct
  // match the evidence slot displaced where the chosen match used to sit, so nothing is lost.
  const follow = (list: RecallMatch[]) => list.flatMap(match => {
    if (!taken.has(match.id)) return [match];
    return displaced && match.id === window[GRAPH_SLOT_INDEX]?.id && !taken.has(displaced.id) ? [displaced] : [];
  });
  const region = follow([...block1.slice(firstRelated ? GRAPH_SLOT_INDEX : GRAPH_SLOT_INDEX + 1), ...block2]);
  const later = follow(laterBlocks.flat());
  // The second linked memory belongs to the second block: a call that stops within the first never sees it. It is
  // the request that decides, not how many picks exist, so a small brain still gets it once topK reaches the block.
  if (secondRelated && topK > RECALL_BLOCK && !taken.has(secondRelated.id)) {
    const own = later.findIndex(match => match.id === secondRelated.id);
    if (own >= 0) later.splice(own, 1); // already listed further down: it moves up to its slot
    region.splice(Math.min(GRAPH_SLOT_INDICES[1] - window.length, region.length), 0, secondRelated);
  }
  const listed = new Set([...window, ...region, ...later].map(match => match.id));
  const matches = [...window, ...region, ...later, ...fillMatches.filter(match => !listed.has(match.id))].slice(0, topK);
  const finalDirectIds = new Set(matches.filter(match => match.hop === 0).map(match => match.id));
  const finalRelated = matches.filter(match => match.hop > 0);
  if (internal.diagnostics) internal.diagnostics.selectedRelatedIds = finalRelated.map(x => x.id);
  if (internal.diagnostics) internal.diagnostics.finalIds = matches.map(match => match.id);
  markStage("selection");

  const presentedDirectIds = finalDirectIds;
  ctx.waitUntil(
    Promise.all(
      [...presentedDirectIds].map(id =>
        env.DB.prepare(`UPDATE entries SET recall_count = recall_count + 1 WHERE id = ?`).bind(id).run()
      )
    ).catch(e => console.error("recall_count update failed (non-fatal):", e))
  );

  const maxScore = matches.reduce((mx, m) => Math.max(mx, m.score), 0);
  if (maxScore > 0) for (const m of matches) m.score = m.score / maxScore;

  if (identity) {
    const actorIdFor = (id: string): string =>
      (d1Map.get(id)?.actor_id as string | undefined)
      ?? (candidateSignalById.get(id) as { actor_id?: string } | undefined)?.actor_id
      ?? "";
    const companyMatches = matches.filter((m) => m.workspace === "company");
    const labelMap = await lookupActorLabels(env, companyMatches.map((m) => actorIdFor(m.id)));
    for (const m of companyMatches) {
      m.actorName = resolveActorLabel(actorIdFor(m.id), labelMap, { viewerId: identity.userId, source: m.source });
    }
  }

  const compoundStale = computeCompoundStale(matches);

  const insight = synthesize && matches.length > 1
    ? await synthesizeInsight(lexicalQuery, matches.map(m => ({ id: m.id, content: m.content })), env, cfg)
    : "";

  markStage("synthesis");
  if (internal.diagnostics) {
    internal.diagnostics.stageMs ??= {};
    internal.diagnostics.stageMs.total = performance.now() - totalStartedAt;
  }

  return { matches, insight, semanticUnavailable, queryUsed: lexicalQuery, queryTokens: tokens, compoundStale };
}
