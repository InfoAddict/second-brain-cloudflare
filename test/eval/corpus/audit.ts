import { CHUNK_MAX_CHARS, FTS_MATCH_BUDGET, FTS_MIN_TOKEN_LENGTH, KEYWORD_CANDIDATE_LIMIT, KEYWORD_MAX_TOKENS } from "../../../src/constants";
import { readScopeWorkspaces } from "../../../src/lib/scope";
import { ftsEligibleToken, ftsMatchQuery } from "../../../src/recall/fts";
import { buildRetrievalTokens } from "../../../src/recall/query-profile";
import { tokenizeQuery } from "../../../src/text/tokenize";
import type { GoldenQuery } from "../types";
import { COMMON_TOKENS, DENSE_TOKENS, generateHaystack } from "./haystack";
import { ACTORS, EVAL_NOW, IDENTITIES, WORKSPACES, type CorpusEdge, type CorpusEntry } from "./types";

export interface AuditFinding { queryId: string; rule: string; detail: string }

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const IDENTIFIER_DF = 5;
/**
 * What a corpus is for. "tie": every common-word union fits inside the LIKE window, so LIKE and FTS see the
 * same rows. "discriminate": each union overflows the window and the gold sits outside it, so LIKE loses it.
 */
export type CorpusIntent = "tie" | "discriminate";
/**
 * Tags: tenancy, cross-lingual, and known-gap (with a gap:T-NNNN board reference). Two gaps are measured
 * (T-0072, underscore identifiers, was fixed and retired; production now keeps "_" in query tokens):
 *  - gap:T-0073  the router sends keyword search to LIKE once the df sum passes FTS_MATCH_BUDGET.
 *  - gap:T-0074  one FTS-ineligible token (under 3 characters) forces the whole query to LIKE.
 * T-0073 and T-0074 only bite at scale: the LIKE window (newest KEYWORD_CANDIDATE_LIMIT matches) holds every
 * match at core-1k, so the query is still answerable there. They are audited at the discriminating scales.
 */
const KNOWN_TAGS: ReadonlySet<string> = new Set(["tenancy", "cross-lingual", "known-gap"]);
const GAP_REF = /^gap:T-\d+$/;
const KEYWORD_SOLVED: ReadonlySet<string> = new Set(["identifier", "rare-word", "common-word", "short-word", "cjk"]);
export type KeywordRoute = "fts" | "like-match-budget" | "like-ineligible-token";
/** The board reference a query must carry when its keyword arm loses the gold on this route. */
export const ROUTE_GAP: Readonly<Record<Exclude<KeywordRoute, "fts">, string>> = { "like-match-budget": "gap:T-0073", "like-ineligible-token": "gap:T-0074" };
const WORD_CHAR = /[\p{L}\p{N}_-]/u;
// Thresholds scale with the rows the viewer can read: a token in 0.4% of 5k rows is not "common".
const commonDf = (rows: number) => Math.max(20, Math.ceil(rows * 0.02));
const rareDf = (rows: number) => Math.max(10, Math.ceil(rows * 0.001));
// Queries are tokenized exactly as production does (NFKC folding, raw-surface probes, trailing "." and "#" kept).
const isIdentifier = (token: string) => /\p{N}/u.test(token) && (/\p{L}/u.test(token) || /[#._-]/u.test(token));
/** True when `token` occurs in `content` (both lowercase) not glued to a longer word or identifier. */
const containsBounded = (content: string, token: string) => {
  for (let at = content.indexOf(token); at >= 0; at = content.indexOf(token, at + 1)) {
    const before = content.slice(0, at).at(-1);
    const after = content.slice(at + token.length).at(0);
    if (!(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after))) return true;
  }
  return false;
};

export interface RouteModel { route: KeywordRoute; terms: string[]; dfSum: number | null; union: number; newer: number; lost: boolean }

/**
 * The keyword arm's route and what it can return, mirroring search.ts keywordSearch with the real tokenizer:
 * retrieval tokens (buildRetrievalTokens), FTS eligibility of every term, then dfSum against FTS_MATCH_BUDGET
 * (skipped for the one-term distill shortcut, which computes no df). On a LIKE route the arm returns the
 * KEYWORD_CANDIDATE_LIMIT newest rows in the viewer's scope matching any term, so the gold is lost when that
 * many matching rows are newer than it. Every term's df counts substrings in the viewer's rows, as LIKE does.
 */
export function keywordRouteModel(
  text: string,
  visible: readonly { entry: CorpusEntry; content: string }[],
  goldCreatedAt: number,
  countRows: (term: string) => number = term => visible.filter(row => row.content.includes(term)).length,
): RouteModel {
  const query = text.trim();
  const words = query.split(/\s+/).filter(Boolean);
  const content = words.filter(word => tokenizeQuery(word).length > 0);
  const uniq = [...new Set(content.flatMap(word => tokenizeQuery(word)))].slice(0, KEYWORD_MAX_TOKENS);
  const distilled = { query: content.length ? content.join(" ") : query, df: null, total: null, distillSource: "shortcut" as const };
  const terms = buildRetrievalTokens(query, distilled).slice(0, KEYWORD_MAX_TOKENS);
  const shortcut = content.length <= 1 && uniq.length <= 1;
  let route: KeywordRoute = "fts";
  let dfSum: number | null = null;
  if (!ftsMatchQuery(terms) || !terms.every(ftsEligibleToken)) route = "like-ineligible-token";
  else if (!shortcut) {
    dfSum = terms.reduce((sum, term) => sum + countRows(term.toLowerCase()), 0);
    if (dfSum > FTS_MATCH_BUDGET) route = "like-match-budget";
  }
  // On FTS the LIKE window is irrelevant: nothing is lost to it, so skip the scan.
  if (route === "fts") return { route, terms, dfSum, union: 0, newer: 0, lost: false };
  const lowered = terms.map(term => term.toLowerCase());
  const matching = visible.filter(row => lowered.some(term => row.content.includes(term)));
  const newer = matching.filter(row => row.entry.createdAt > goldCreatedAt).length;
  return { route, terms, dfSum, union: matching.length, newer, lost: newer >= KEYWORD_CANDIDATE_LIMIT };
}

export function auditQueries(spec: {
  entries: readonly CorpusEntry[];
  edges: readonly CorpusEdge[];
  queries: readonly GoldenQuery[];
  intent: CorpusIntent;
}): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const add = (queryId: string, rule: string, detail: string) => findings.push({ queryId, rule, detail });
  const byId = new Map(spec.entries.map(entry => [entry.id, entry] as const));
  const lower = spec.entries.map(entry => ({ entry, content: entry.content.toLowerCase() }));
  const lowerById = new Map(lower.map(row => [row.entry.id, row.content] as const));
  // df is per viewer: only rows the viewer can read count, so unreadable decoys never inflate it.
  const views = new Map<string, { rows: number; visible: { entry: CorpusEntry; content: string }[]; df: (token: string) => number }>();
  const viewOf = (readable: ReadonlySet<string>) => {
    const key = [...readable].sort().join("|");
    if (!views.has(key)) {
      const visible = lower.filter(row => readable.has(row.entry.workspaceId));
      const cache = new Map<string, number>();
      views.set(key, {
        rows: visible.length,
        visible,
        df: token => {
          if (!cache.has(token)) cache.set(token, visible.filter(row => row.content.includes(token)).length);
          return cache.get(token)!;
        },
      });
    }
    return views.get(key)!;
  };
  const neighbors = new Map<string, Set<string>>();
  for (const edge of spec.edges) {
    if (!neighbors.has(edge.sourceId)) neighbors.set(edge.sourceId, new Set());
    if (!neighbors.has(edge.targetId)) neighbors.set(edge.targetId, new Set());
    neighbors.get(edge.sourceId)!.add(edge.targetId);
    neighbors.get(edge.targetId)!.add(edge.sourceId);
  }
  const seen = new Set<string>();

  for (const query of spec.queries) {
    if (seen.has(query.id)) add(query.id, "duplicate-id", query.id);
    seen.add(query.id);
    if (!query.text.trim()) add(query.id, "empty-text", "");
    const readable = new Set(readScopeWorkspaces(IDENTITIES[query.viewer], { layer: query.layer }));
    const goldEntries = query.gold.map(gold => byId.get(gold.id));
    if (!query.gold.length || goldEntries.some(entry => !entry)) {
      add(query.id, "gold-missing", query.gold.map(gold => gold.id).join(","));
      continue;
    }
    if (goldEntries.some(entry => !readable.has(entry!.workspaceId))) add(query.id, "gold-unreadable", "gold is outside the viewer's scope");
    const primary = byId.get((query.gold.find(gold => gold.grade === 2) ?? query.gold[0]).id)!;
    const content = lowerById.get(primary.id)!;
    const { rows, visible, df } = viewOf(readable);
    const common = commonDf(rows);
    const tokens = tokenizeQuery(query.text);
    const shared = tokens.filter(token => content.includes(token));
    const cross = query.tags?.includes("cross-lingual") ?? false;
    for (const tag of query.tags ?? []) if (!KNOWN_TAGS.has(tag) && !GAP_REF.test(tag)) add(query.id, "unknown-tag", tag);
    // A known gap must name its board item; the tag waives no audit rule by itself.
    const gapRefs = (query.tags ?? []).filter(tag => GAP_REF.test(tag));
    const knownGap = query.tags?.includes("known-gap") ?? false;
    if (knownGap && !gapRefs.length) add(query.id, "known-gap-no-ref", "tag gap:T-NNNN is required");
    // T-0073 queries add ordinary common tokens on purpose, to push the df sum past the router's FTS budget.
    const overBudgetGap = knownGap && gapRefs.includes(ROUTE_GAP["like-match-budget"]);
    if (!knownGap && gapRefs.length) add(query.id, "gap-ref-without-known-gap", gapRefs.join(","));
    // The outsider reads no haystack rows, so it only serves tenancy (decoy) queries.
    if (query.viewer === "outsider" && !query.tags?.includes("tenancy")) add(query.id, "outsider-not-tenancy", "outsider reads no haystack rows");
    let keyToken: string | undefined;

    switch (query.category) {
      case "identifier": {
        keyToken = tokens.find(token => isIdentifier(token) && [...token].length >= 3);
        if (!keyToken) add(query.id, "identifier-no-token", query.text);
        else if (!containsBounded(content, keyToken)) add(query.id, "identifier-not-in-gold", keyToken);
        else if (df(keyToken) > IDENTIFIER_DF) add(query.id, "identifier-too-common", `${keyToken} df=${df(keyToken)}`);
        break;
      }
      case "rare-word": {
        const rare = tokens.filter(token => df(token) <= rareDf(rows) && content.includes(token));
        keyToken = rare[0];
        if (!rare.length) add(query.id, "rare-word-no-rare-token", query.text);
        break;
      }
      case "common-word": {
        // The dense tier only guarantees a full match per scope for the default (personal + company) read scope.
        if (query.layer || query.viewer === "outsider") add(query.id, "common-word-layer-scoped", `${query.viewer}/${query.layer ?? "default"}`);
        if (tokens.length < 2) add(query.id, "common-word-too-short", query.text);
        // Only the dense tier is guaranteed to overflow the keyword window at 5k+ while unique per triple.
        const sparse = tokens.find(token => !(DENSE_TOKENS as readonly string[]).includes(token) && !(overBudgetGap && (COMMON_TOKENS as readonly string[]).includes(token)));
        if (sparse) add(query.id, "common-word-not-dense", sparse);
        const rare = tokens.find(token => df(token) < common);
        if (rare) add(query.id, "common-word-rare-token", `${rare} df=${df(rare)}`);
        if (shared.length < tokens.length) add(query.id, "common-word-gold-missing-token", query.text);
        const goldIds = new Set(query.gold.map(gold => gold.id));
        const rivals = lower.filter(row => !goldIds.has(row.entry.id) && readable.has(row.entry.workspaceId) && tokens.every(token => row.content.includes(token.toLowerCase())));
        if (tokens.length && rivals.length) add(query.id, "common-word-ambiguous", `${rivals.length} non-gold readable entries contain every token, e.g. ${rivals[0].entry.id}`);
        // LIKE keeps the KEYWORD_CANDIDATE_LIMIT newest rows matching any term. A union that fits in the window
        // cannot be truncated, so recency only matters once the union overflows it.
        const union = visible.filter(row => tokens.some(token => row.content.includes(token)));
        if (spec.intent === "tie") {
          if (union.length > KEYWORD_CANDIDATE_LIMIT) add(query.id, "common-word-union-truncates", `union=${union.length}`);
        } else {
          if (union.length <= KEYWORD_CANDIDATE_LIMIT) add(query.id, "common-word-union-under-window", `union=${union.length}`);
          else {
            const newer = union.filter(row => row.entry.createdAt > primary.createdAt).length;
            if (newer < KEYWORD_CANDIDATE_LIMIT) add(query.id, "common-word-gold-in-window", `${newer} newer union rows of ${union.length}`);
          }
          // An ordinary common-word query must stay on FTS; only a query that names T-0073 may cross the budget.
          const dfSum = tokens.reduce((sum, token) => sum + df(token), 0);
          if (!overBudgetGap && dfSum > FTS_MATCH_BUDGET) add(query.id, "common-word-over-fts-budget", `dfSum=${dfSum}`);
        }
        break;
      }
      case "short-word": {
        if (!tokens.some(token => [...token].length < FTS_MIN_TOKEN_LENGTH)) add(query.id, "short-word-no-short-token", query.text);
        if (shared.length < tokens.length) add(query.id, "short-word-gold-missing-token", query.text);
        break;
      }
      case "paraphrase": {
        const leaking = shared.filter(token => df(token) < common);
        if (leaking.length) add(query.id, "paraphrase-lexical-leak", leaking.join(","));
        break;
      }
      case "cjk": {
        if (!CJK.test(primary.content)) add(query.id, "cjk-gold-not-cjk", primary.id);
        if (cross) {
          // Cross-lingual means no CJK in the query, and no shared Latin word rarer than "common".
          if (CJK.test(query.text)) add(query.id, "cross-lingual-has-cjk", query.text);
          const leaking = shared.filter(token => df(token) < common);
          if (leaking.length) add(query.id, "cross-lingual-lexical-leak", leaking.join(","));
        } else {
          if (!CJK.test(query.text)) add(query.id, "cjk-no-cjk-text", query.text);
          // The arm searches whole tokens, so a CJK token must occur in the gold.
          if (!shared.some(token => CJK.test(token))) add(query.id, "cjk-no-shared-substring", query.text);
        }
        break;
      }
      case "multi-hop": {
        if (query.hops !== 1) add(query.id, "multi-hop-needs-hops", String(query.hops));
        if (shared.length > 1) add(query.id, "multi-hop-lexical-leak", shared.join(","));
        const reachable = [...(neighbors.get(primary.id) ?? [])].some(rootId => {
          const root = byId.get(rootId);
          const rootContent = lowerById.get(rootId);
          return root && root.id !== primary.id && readable.has(root.workspaceId) && rootContent && tokens.filter(token => rootContent.includes(token)).length >= Math.min(2, tokens.length);
        });
        if (!reachable) add(query.id, "multi-hop-unreachable", primary.id);
        break;
      }
      case "long-context": {
        if (primary.content.length <= CHUNK_MAX_CHARS) add(query.id, "long-context-single-chunk", String(primary.content.length));
        if (shared.length > 1) add(query.id, "long-context-lexical-leak", shared.join(","));
        if (!query.answerSpan || primary.content.indexOf(query.answerSpan) < CHUNK_MAX_CHARS) add(query.id, "long-context-answer-in-first-chunk", query.answerSpan ?? "no answerSpan");
        break;
      }
    }

    // If the keyword arm routes to LIKE and loses the gold, the query is a measured production gap. The tie scale
    // must not lose anything; at the discriminating scales the gap must be named where the keyword arm is the
    // intended solver. Paraphrase, multi-hop, long-context and cross-lingual queries are non-lexical by
    // construction (their dense or graph arm answers them), so a keyword loss there is not a gap to board.
    const model = keywordRouteModel(query.text, visible, primary.createdAt, df);
    if (spec.intent === "tie") {
      if (model.lost) add(query.id, "route-gap-unanswerable-at-tie", `${model.route}: ${model.newer} newer of ${model.union}`);
    } else if (model.lost && model.route !== "fts" && KEYWORD_SOLVED.has(query.category) && !cross) {
      const needed = ROUTE_GAP[model.route];
      if (!(knownGap && gapRefs.includes(needed))) add(query.id, "keyword-route-unflagged-gap", `${model.route} loses the gold (${model.newer} newer of ${model.union}, dfSum=${model.dfSum}): needs known-gap + ${needed}`);
    }

    if (query.tags?.includes("tenancy")) {
      if (!keyToken) add(query.id, "tenancy-no-key-token", query.category);
      else if (!lower.some(row => !readable.has(row.entry.workspaceId) && row.content.includes(keyToken!))) add(query.id, "tenancy-no-decoy", keyToken);
    }
  }
  return findings;
}

export function haystackVocabulary(): Set<string> {
  const rows = generateHaystack({
    count: 8000, seed: 1, commonRate: 0.5, idPrefix: "v", now: EVAL_NOW, spanDays: 730, cjkRate: 0.2, longRate: 0.05, denseRate: 1,
    workspaces: [{ workspaceId: WORKSPACES.avery, actorId: ACTORS.avery, weight: 1 }],
  });
  const vocabulary = new Set(rows.flatMap(row => tokenizeQuery(row.content).map(token => token.replace(/[^\p{L}\p{N}]+$/gu, ""))));
  for (const prefix of ["ops", "web", "app"]) {
    for (let number = 1000; number < 8000; number++) vocabulary.add(`${prefix}-${number}`);
  }
  return vocabulary;
}

/**
 * A route gap tag (T-0073, T-0074) must be earned: the query has to lose its gold on that very route at one
 * of the discriminating corpora at least, or the tag is stale. Gaps are scale-dependent, so this looks across scales.
 */
export function staleRouteGaps(corpora: readonly { entries: readonly CorpusEntry[]; queries: readonly GoldenQuery[]; intent: CorpusIntent }[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const routeOf = new Map(Object.entries(ROUTE_GAP).map(([route, ref]) => [ref, route] as const));
  const tagged = new Map<string, GoldenQuery>();
  for (const corpus of corpora) for (const query of corpus.queries) if (query.tags?.some(tag => routeOf.has(tag))) tagged.set(query.id, query);
  for (const query of tagged.values()) {
    for (const ref of query.tags!.filter(tag => routeOf.has(tag))) {
      const reached = corpora.some(corpus => {
        if (corpus.intent !== "discriminate") return false;
        const primary = corpus.entries.find(entry => entry.id === (query.gold.find(gold => gold.grade === 2) ?? query.gold[0]).id);
        if (!primary) return false;
        const readable = new Set(readScopeWorkspaces(IDENTITIES[query.viewer], { layer: query.layer }));
        const visible = corpus.entries.filter(entry => readable.has(entry.workspaceId)).map(entry => ({ entry, content: entry.content.toLowerCase() }));
        const model = keywordRouteModel(query.text, visible, primary.createdAt);
        return model.lost && model.route === routeOf.get(ref);
      });
      if (!reached) findings.push({ queryId: query.id, rule: "gap-not-reached", detail: `${ref} is never lost on ${routeOf.get(ref)} at a discriminating scale` });
    }
  }
  return findings;
}
