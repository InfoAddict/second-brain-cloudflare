import { storeEntry } from "../../src/capture/store";
import type { Config } from "../../src/config";
import type { RecallInternalOptions } from "../../src/recall/types";
import type { IndexVariant } from "./corpus/loader";
import type { QueryCategory } from "./types";

export type VariantInternal = Omit<RecallInternalOptions, "identity" | "workspaceFilter" | "teamId" | "diagnostics">;

export interface VariantSpec {
  name: string;
  description: string;
  /** Query-time flags passed to recallEntries (RecallInternalOptions). T-0041's rerank switch goes here. */
  internal?: VariantInternal;
  /** Config overrides (defaults come from src/config.ts DEFAULTS, never from KV). */
  config?: Partial<Config>;
  /** Whether fts:ready is set for this run. Default true. */
  ftsReady?: boolean;
  /** Index-time variant: indexes the corpus through this storeEntry instead of the shipped one (T-0042). */
  index?: IndexVariant;
  /** Categories this variant claims to help; enables the gate's targeted-gain path. */
  targetCategories?: readonly QueryCategory[];
  /** Known gaps (ids like "T-0072") this variant claims to fix: their queries rejoin the gate and get an improvement path. */
  targetGaps?: readonly string[];
}

/*
 * How T-0041 and T-0042 plug in:
 *
 *   registerVariant({ name: "rerank", description: "...", internal: { variant: { rerank: true } },
 *                     targetCategories: ["paraphrase", "common-word"] });
 *   registerVariant({ name: "contextual-embed", description: "...",
 *                     index: { id: "contextual-embed", storeEntry: storeEntryContextual },
 *                     targetCategories: ["long-context", "paraphrase"] });
 *
 * then `npm run eval:recall -- prepare --variant <name> --corpus core-1k` records the AI
 * calls the variant needs (rerank scores, or re-embedded chunks), and
 * `npm run eval:recall -- --compare baseline,<name>` gates it.
 */
// The ablations isolate one retrieval factor each, so they run without the reranker (which ships on in "auto").
const NO_RERANK: Partial<Config> = { RERANK_MODE: "off" };
const builtin: VariantSpec[] = [
  { name: "baseline", description: "Shipped recall with the FTS arm ready and every default (the reranker in its shipped auto mode)." },
  { name: "like", description: "Keyword arm forced onto the LIKE fallback (fts:ready cleared).", ftsReady: false, config: NO_RERANK },
  { name: "fts-orderless", description: "FTS candidates with bm25 order disabled in fusion (isolates candidate selection from fusion order).", internal: { keywordPreRankedOverride: false }, config: NO_RERANK },
  { name: "no-rerank", description: "Shipped recall with the cross-encoder reranker off (the pre-T-0041 ordering).", config: NO_RERANK },
  { name: "rerank-auto", description: "The shipped reranker in its auto mode, with its target categories pre-registered: the ship-decision candidate (`--compare no-rerank,rerank-auto`). Paraphrase is the only target: multi-hop has no headroom (mrr@10 0.974).", targetCategories: ["paraphrase"] },
  { name: "rerank", description: "Cross-encoder reranking forced on for every eligible recall (auto's ambiguity gate bypassed).", internal: { variant: { rerank: true } }, targetCategories: ["paraphrase"] },
  { name: "dense-only", description: "Ablation: keyword arm skipped. Must lose on identifier and rare-word queries.", internal: { variant: { arms: "dense-only" } }, config: NO_RERANK },
  { name: "keyword-only", description: "Ablation: embedding and Vectorize skipped. Must lose on paraphrase queries.", internal: { variant: { arms: "keyword-only" } }, config: NO_RERANK },
];

/** The shipped write path with config overrides layered on, so a stored-vector variant re-embeds the corpus under them. */
const storeWith = (over: Partial<Config>): typeof storeEntry => (env, id, content, tags, source, now, config, writeCtx) =>
  storeEntry(env, id, content, tags, source, now, Object.freeze({ ...config, ...over } as Config), writeCtx);

/** A variant whose stored vectors (and its queries) are made under `over`. */
const embedVariant = (name: string, description: string, over: Partial<Config>, extra: Partial<VariantSpec> = {}): VariantSpec =>
  ({ name, description, config: over, index: { id: name, storeEntry: storeWith(over) }, ...extra });

builtin.push(
  embedVariant("legacy-embed", "The pre-T-0042 scheme: raw chunks, mean pooling. The reference for scheme comparisons once the shipped default moves.", { CONTEXTUAL_EMBEDDINGS: "off", EMBEDDING_POOLING: "mean" }),
  embedVariant("contextual-embed", "Multi-chunk memories are embedded with a transient entry-level prefix (T-0042).", { CONTEXTUAL_EMBEDDINGS: "on", EMBEDDING_POOLING: "mean" }, { targetCategories: ["long-context", "paraphrase"] }),
  embedVariant("cls-pooling", "bge-en embeddings use CLS pooling instead of Workers AI's default mean (T-0077).", { CONTEXTUAL_EMBEDDINGS: "off", EMBEDDING_POOLING: "cls" }),
  embedVariant("contextual-cls", "Contextual chunk embeddings and CLS pooling together.", { CONTEXTUAL_EMBEDDINGS: "on", EMBEDDING_POOLING: "cls" }, { targetCategories: ["long-context", "paraphrase"] }),
);

export const VARIANTS: Record<string, VariantSpec> = Object.fromEntries(builtin.map(v => [v.name, v]));

const BUILTIN = new Set(builtin.map(v => v.name));

export function registerVariant(spec: VariantSpec): void {
  if (VARIANTS[spec.name]) throw new Error(`variant "${spec.name}" is already registered`);
  VARIANTS[spec.name] = spec;
}

/** For tests: removes a registered variant. Builtins cannot be removed. */
export function unregisterVariant(name: string): void {
  if (BUILTIN.has(name)) throw new Error(`"${name}" is a builtin variant and cannot be unregistered`);
  delete VARIANTS[name];
}

/** `rerank:w50f25k30e400` = rerank forced on with blend weight 0.50, floor 0.25 (optional), 30 candidates, 400-character excerpts (tuning grid; never a shipped setting). */
const TUNED = /^rerank:w(\d+)(?:f(\d+))?k(\d+)e(\d+)$/;

export function getVariant(name: string): VariantSpec {
  const t = TUNED.exec(name);
  if (t) {
    const [weight, floor, maxCandidates, excerptChars] = [Number(t[1]) / 100, t[2] === undefined ? undefined : Number(t[2]) / 100, Number(t[3]), Number(t[4])];
    return { name, description: `Reranker forced on, weight ${weight}, ${maxCandidates} candidates, ${excerptChars}-char excerpts.`, internal: { variant: { rerank: true, rerankTuning: { weight, ...(floor !== undefined && { floor }), maxCandidates, excerptChars } } }, targetCategories: ["paraphrase", "multi-hop"] };
  }
  const spec = VARIANTS[name];
  if (!spec) throw new Error(`unknown variant "${name}". Known: ${Object.keys(VARIANTS).join(", ")}`);
  return spec;
}
