import { CHUNK_MAX_CHARS, FTS_MIN_TOKEN_LENGTH } from "../../../src/constants";
import { readScopeWorkspaces } from "../../../src/lib/scope";
import { tokenizeQuery } from "../../../src/text/tokenize";
import type { GoldenQuery } from "../types";
import { generateHaystack } from "./haystack";
import { ACTORS, EVAL_NOW, IDENTITIES, WORKSPACES, type CorpusEdge, type CorpusEntry } from "./types";

export interface AuditFinding { queryId: string; rule: string; detail: string }

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu;
const RARE_DF = 10;
const COMMON_DF = 20;
const IDENTIFIER_DF = 5;
const auditTokens = (text: string) => tokenizeQuery(text).map(token => token.replace(/[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
const isIdentifier = (token: string) => /\p{N}/u.test(token) && (/[\p{L}]/u.test(token) || /[#._-]/u.test(token));
const hasSharedCjkPair = (query: string, content: string) => {
  for (const run of query.matchAll(CJK_RUN)) {
    const chars = [...run[0]];
    for (let i = 0; i < chars.length - 1; i++) if (content.includes(chars[i] + chars[i + 1])) return true;
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
  const tokensById = new Map(spec.entries.map(entry => [entry.id, new Set(auditTokens(entry.content))] as const));
  const frequency = new Map<string, number>();
  const df = (token: string) => {
    const key = token.toLowerCase();
    if (!frequency.has(key)) frequency.set(key, lower.filter(row => row.content.includes(key)).length);
    return frequency.get(key)!;
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
    const contentTokens = tokensById.get(primary.id)!;
    const content = lowerById.get(primary.id)!;
    const tokens = auditTokens(query.text);
    const shared = tokens.filter(token => content.includes(token.toLowerCase()));
    let keyToken: string | undefined;

    switch (query.category) {
      case "identifier": {
        keyToken = tokens.find(token => isIdentifier(token) && [...token].length >= 3);
        if (!keyToken) add(query.id, "identifier-no-token", query.text);
        else if (!contentTokens.has(keyToken.toLowerCase())) add(query.id, "identifier-not-in-gold", keyToken);
        else if (df(keyToken) > IDENTIFIER_DF) add(query.id, "identifier-too-common", `${keyToken} df=${df(keyToken)}`);
        break;
      }
      case "rare-word": {
        const rare = tokens.filter(token => df(token) > 0 && df(token) <= RARE_DF && content.includes(token.toLowerCase()));
        keyToken = rare[0];
        if (!rare.length) add(query.id, "rare-word-no-rare-token", query.text);
        break;
      }
      case "common-word": {
        if (tokens.length < 2) add(query.id, "common-word-too-short", query.text);
        const rare = tokens.find(token => df(token) < COMMON_DF);
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
        const leaking = shared.filter(token => df(token) < COMMON_DF);
        if (leaking.length) add(query.id, "paraphrase-lexical-leak", leaking.join(","));
        break;
      }
      case "cjk": {
        if (!CJK.test(query.text) && !query.tags?.includes("cross-lingual")) add(query.id, "cjk-no-cjk-text", query.text);
        if (!CJK.test(primary.content)) add(query.id, "cjk-gold-not-cjk", primary.id);
        if (!query.tags?.includes("cross-lingual") && !hasSharedCjkPair(query.text, primary.content)) add(query.id, "cjk-no-shared-substring", query.text);
        break;
      }
      case "multi-hop": {
        if (query.hops !== 1) add(query.id, "multi-hop-needs-hops", String(query.hops));
        if (shared.length > 1) add(query.id, "multi-hop-lexical-leak", shared.join(","));
        const reachable = [...(neighbors.get(primary.id) ?? [])].some(rootId => {
          const root = byId.get(rootId);
          const rootContent = lowerById.get(rootId);
          return root && root.id !== primary.id && readable.has(root.workspaceId) && rootContent && tokens.filter(token => rootContent.includes(token.toLowerCase())).length >= Math.min(2, tokens.length);
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
      const key = keyToken ?? tokens[0];
      const decoy = lower.some(row => !readable.has(row.entry.workspaceId) && key && row.content.includes(key.toLowerCase()));
      if (!decoy) add(query.id, "tenancy-no-decoy", key ?? "");
    }
  }
  return findings;
}

export function haystackVocabulary(): Set<string> {
  const rows = generateHaystack({
    count: 4000, seed: 1, commonRate: 0.5, idPrefix: "v", now: EVAL_NOW, spanDays: 730, cjkRate: 0.2, longRate: 0.05,
    workspaces: [{ workspaceId: WORKSPACES.avery, actorId: ACTORS.avery, weight: 1 }],
  });
  const vocabulary = new Set(rows.flatMap(row => auditTokens(row.content)));
  for (const prefix of ["ops", "web", "app"]) {
    for (let number = 1000; number < 8000; number++) vocabulary.add(`${prefix}-${number}`);
  }
  return vocabulary;
}
