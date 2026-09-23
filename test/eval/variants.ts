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
const builtin: VariantSpec[] = [
  { name: "baseline", description: "Shipped recall with the FTS arm ready and every default." },
  { name: "like", description: "Keyword arm forced onto the LIKE fallback (fts:ready cleared).", ftsReady: false },
  { name: "fts-orderless", description: "FTS candidates with bm25 order disabled in fusion (isolates candidate selection from fusion order).", internal: { keywordPreRankedOverride: false } },
  { name: "dense-only", description: "Ablation: keyword arm skipped. Must lose on identifier and rare-word queries.", internal: { variant: { arms: "dense-only" } } },
  { name: "keyword-only", description: "Ablation: embedding and Vectorize skipped. Must lose on paraphrase queries.", internal: { variant: { arms: "keyword-only" } } },
];

export const VARIANTS: Record<string, VariantSpec> = Object.fromEntries(builtin.map(v => [v.name, v]));

export function registerVariant(spec: VariantSpec): void {
  VARIANTS[spec.name] = spec;
}

export function getVariant(name: string): VariantSpec {
  const spec = VARIANTS[name];
  if (!spec) throw new Error(`unknown variant "${name}". Known: ${Object.keys(VARIANTS).join(", ")}`);
  return spec;
}
