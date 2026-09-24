/**
 * The embedding scheme: everything besides the model that decides what a
 * stored vector means. Scheme 1 is what every brain held before T-0042: the
 * raw chunk, mean pooling. A brain's vectors may be a mix of schemes; the
 * migration in src/migration/embedding.ts moves them to the configured one.
 *
 * Two knobs feed it, and they differ in what a mixed brain risks:
 *  - contextual text changes only what is embedded, not the vector space, so
 *    old and new vectors rank against the same query vector;
 *  - pooling changes the space itself, so a query vector is only meaningful
 *    against vectors of the same pooling (see `poolingOf`).
 */
import type { Config } from "../config";

export const LEGACY_SCHEME = 1;

type SchemeInputs = Readonly<Config>;

/** bge-m3 is always CLS and ignores the setting. */
const poolingSetting = (c: SchemeInputs): "mean" | "cls" =>
  c.EMBEDDING_MODEL === "@cf/baai/bge-m3" ? "mean" : c.EMBEDDING_POOLING === "cls" ? "cls" : "mean";

/** 1 = plain mean; +1 contextual; +2 cls. Stamped on vector metadata whenever it is not 1. */
export function schemeOf(c: SchemeInputs): number {
  return LEGACY_SCHEME + (c.CONTEXTUAL_EMBEDDINGS === "on" ? 1 : 0) + (poolingSetting(c) === "cls" ? 2 : 0);
}

export const poolingOf = (scheme: number): "mean" | "cls" => (scheme >= 4 || scheme === 3 ? "cls" : "mean");

/** The scheme a vector was written under; vectors from before schemes existed carry no field. */
export const vectorScheme = (metadata: Record<string, unknown> | undefined): number =>
  typeof metadata?.scheme === "number" ? metadata.scheme : LEGACY_SCHEME;
