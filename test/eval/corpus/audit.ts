import { CHUNK_MAX_CHARS, FTS_MIN_TOKEN_LENGTH, KEYWORD_CANDIDATE_LIMIT } from "../../../src/constants";
import { readScopeWorkspaces } from "../../../src/lib/scope";
import { tokenizeQuery } from "../../../src/text/tokenize";
import type { GoldenQuery } from "../types";
import { generateHaystack } from "./haystack";
import { ACTORS, EVAL_NOW, IDENTITIES, WORKSPACES, type CorpusEdge, type CorpusEntry } from "./types";

export interface AuditFinding { queryId: string; rule: string; detail: string }

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const IDENTIFIER_DF = 5;
const KNOWN_TAGS: ReadonlySet<string> = new Set(["tenancy", "cross-lingual"]);
const WORD_CHAR = /[\p{L}\p{N}_-]/u;
// Thresholds scale with the rows the viewer can read: a token in 0.4% of 5k rows is not "common".
const commonDf = (rows: number) => Math.min(KEYWORD_CANDIDATE_LIMIT, Math.max(20, Math.ceil(rows * 0.02)));
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

export function auditQueries(spec: {
  entries: readonly CorpusEntry[];
  edges: readonly CorpusEdge[];
  queries: readonly GoldenQuery[];
}): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const add = (queryId: string, rule: string, detail: string) => findings.push({ queryId, rule, detail });
  const byId = new Map(spec.entries.map(entry => [entry.id, entry] as const));
  const lower = spec.entries.map(entry => ({ entry, content: entry.content.toLowerCase() }));
  const lowerById = new Map(lower.map(row => [row.entry.id, row.content] as const));
  // df is per viewer: only rows the viewer can read count, so unreadable decoys never inflate it.
  const views = new Map<string, { rows: number; df: (token: string) => number }>();
  const viewOf = (readable: ReadonlySet<string>) => {
    const key = [...readable].sort().join("|");
    if (!views.has(key)) {
      const visible = lower.filter(row => readable.has(row.entry.workspaceId));
      const cache = new Map<string, number>();
      views.set(key, {
        rows: visible.length,
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
    const { rows, df } = viewOf(readable);
    const common = commonDf(rows);
    const tokens = tokenizeQuery(query.text);
    const shared = tokens.filter(token => content.includes(token));
    const cross = query.tags?.includes("cross-lingual") ?? false;
    for (const tag of query.tags ?? []) if (!KNOWN_TAGS.has(tag)) add(query.id, "unknown-tag", tag);
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
        const rare = tokens.find(token => df(token) < common);
        if (rare) add(query.id, "common-word-rare-token", `${rare} df=${df(rare)}`);
        if (shared.length < tokens.length) add(query.id, "common-word-gold-missing-token", query.text);
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

    if (query.tags?.includes("tenancy")) {
      if (!keyToken) add(query.id, "tenancy-no-key-token", query.category);
      else if (!lower.some(row => !readable.has(row.entry.workspaceId) && row.content.includes(keyToken!))) add(query.id, "tenancy-no-decoy", keyToken);
    }
  }
  return findings;
}

export function haystackVocabulary(): Set<string> {
  const rows = generateHaystack({
    count: 8000, seed: 1, commonRate: 0.5, idPrefix: "v", now: EVAL_NOW, spanDays: 730, cjkRate: 0.2, longRate: 0.05,
    workspaces: [{ workspaceId: WORKSPACES.avery, actorId: ACTORS.avery, weight: 1 }],
  });
  const vocabulary = new Set(rows.flatMap(row => tokenizeQuery(row.content).map(token => token.replace(/[^\p{L}\p{N}]+$/gu, ""))));
  for (const prefix of ["ops", "web", "app"]) {
    for (let number = 1000; number < 8000; number++) vocabulary.add(`${prefix}-${number}`);
  }
  return vocabulary;
}
