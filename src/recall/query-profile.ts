import type { EdgeType } from "../graph/types";
import { KEYWORD_MAX_TOKENS } from "../constants";
import { tokenizeQuery } from "../text/tokenize";
import type { DistilledQuery } from "./distill";

export type RecallIntent = "causal" | "chronology" | "current" | "direct";
export type EmbeddingQueryMode = "distilled" | "semantic" | "hybrid";
export const DEFAULT_EMBEDDING_QUERY_MODE: EmbeddingQueryMode = "distilled";

export interface QueryProfile {
  semanticQuery: string;
  lexicalQuery: string;
  lexicalTokens: string[];
  evidenceTokens: string[];
  retrievalTokens: string[];
  intent: RecallIntent;
}

function identifierShaped(token: string): boolean {
  return /[\d#.]/.test(token) || token.includes("-");
}

function deterministicVariants(query: string, tokens: string[]): string[] {
  const variants: string[] = [];
  const add = (value: string) => {
    const normalized = value.toLowerCase().trim();
    if (normalized.length >= 2 && !variants.includes(normalized)) variants.push(normalized);
  };

  for (const token of tokens.filter(value => value.includes("-"))) {
    add(token.replace(/-/g, ""));
    token.split("-").forEach(add);
  }

  const titleRun: string[] = [];
  const flushTitleRun = () => {
    if (titleRun.length >= 2 && titleRun.length <= 4) add(titleRun.map(word => word[0]).join(""));
    titleRun.length = 0;
  };
  for (const raw of query.split(/\s+/)) {
    const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (/^[A-Z][A-Za-z0-9]*$/.test(word) && tokenizeQuery(word).length === 1) titleRun.push(word);
    else flushTitleRun();
  }
  flushTitleRun();

  const month = "january|february|march|april|may|june|july|august|september|october|november|december";
  for (const match of query.matchAll(new RegExp(`\\b(?:${month})\\s+\\d{1,2}(?:,?\\s+\\d{4})?\\b`, "gi"))) add(match[0]);

  const stems = [...tokens, ...variants.filter(value => !value.includes(" "))];
  for (const token of stems) {
    if (token.length > 5 && token.endsWith("ies")) add(`${token.slice(0, -3)}y`);
    else if (token.length > 4 && token.endsWith("es")) add(token.slice(0, -2));
    else if (token.length > 3 && token.endsWith("s")) add(token.slice(0, -1));
    if (token.length > 5 && token.endsWith("ing")) add(token.slice(0, -3));
    if (token.length > 4 && token.endsWith("ed")) add(token.slice(0, -2));
  }
  return variants;
}

export function buildRetrievalTokens(
  semanticQuery: string,
  distilled: DistilledQuery,
): string[] {
  const evidence = tokenizeQuery(semanticQuery).slice(0, KEYWORD_MAX_TOKENS);
  const position = new Map(evidence.map((token, index) => [token, index]));
  const distilledTokens = tokenizeQuery(distilled.query);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const append = (token: string) => {
    if (ordered.length >= KEYWORD_MAX_TOKENS || seen.has(token)) return;
    seen.add(token);
    ordered.push(token);
  };

  distilledTokens.forEach(append);
  evidence.filter(identifierShaped).forEach(append);
  evidence
    .filter(token => distilled.df?.has(token))
    .sort((a, b) => (distilled.df!.get(a)! - distilled.df!.get(b)!)
      || ((position.get(a) ?? 0) - (position.get(b) ?? 0)))
    .forEach(append);
  evidence.forEach(append);
  deterministicVariants(semanticQuery, evidence).forEach(append);
  return ordered;
}

const WORD = (items: string[]) => new RegExp(`(?<![\\w-])(?:${items.join("|")})(?![\\w-])`, "i");
const CAUSAL = WORD(["why", "reason", "decide", "decided", "chose", "choice", "changed", "change", "switched"]);
const CHRONOLOGY = WORD(["before", "after", "then", "history", "evolution", "became"]);
const CURRENT = WORD(["current", "now", "still", "latest"]);

export function buildQueryProfile(semanticQuery: string, distilled: DistilledQuery): QueryProfile {
  const clean = semanticQuery.trim();
  const intent: RecallIntent = CAUSAL.test(clean)
    ? "causal"
    : CHRONOLOGY.test(clean)
      ? "chronology"
      : CURRENT.test(clean)
        ? "current"
        : "direct";
  const evidenceTokens = tokenizeQuery(clean).slice(0, KEYWORD_MAX_TOKENS);
  return {
    semanticQuery: clean,
    lexicalQuery: distilled.query,
    lexicalTokens: tokenizeQuery(distilled.query),
    evidenceTokens,
    retrievalTokens: buildRetrievalTokens(clean, distilled),
    intent,
  };
}

export function embeddingInput(profile: QueryProfile, mode: EmbeddingQueryMode): string {
  if (mode === "semantic") return profile.semanticQuery;
  if (mode === "hybrid") return profile.semanticQuery === profile.lexicalQuery
    ? profile.semanticQuery
    : `${profile.semanticQuery} ${profile.lexicalQuery}`;
  return profile.lexicalQuery;
}

export function edgeIntentCompatibility(intent: RecallIntent, edgeType: EdgeType): number {
  if (intent === "causal" && ["decided", "caused_by", "supersedes"].includes(edgeType)) return 1;
  if (intent === "chronology" && ["follows", "supersedes"].includes(edgeType)) return 1;
  return 0.5;
}
