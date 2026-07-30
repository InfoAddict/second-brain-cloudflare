import type { Env } from "../env";

/**
 * The index name declared in wrangler.jsonc. This is a *last resort* only: it is
 * what we deployed with, not necessarily what is bound now. Vectorize's two
 * describe() shapes disagree about whether an index can name itself — the beta
 * shape (VectorizeIndexDetails) carries `name`, the current V2 shape
 * (VectorizeIndexInfo) carries no name field at all — so when the binding is
 * repointed at a differently-named index (e.g. an embedding migration to
 * second-brain-vectors-768) this constant silently goes stale. Never treat it as
 * the identity of the live index.
 */
export const FALLBACK_VECTORIZE_INDEX_NAME = "second-brain-vectors";

export interface VectorizeHealth {
  ok: boolean;
  /** The bound index's own name when describe() reports one, else FALLBACK_VECTORIZE_INDEX_NAME. Always a string — the dashboard banner interpolates it. */
  indexName: string;
  dimensions?: number;
  /** Records containing vectors in the bound index. Omitted when describe() does not report a numeric count. */
  vectorCount?: number;
  error?: string;
}

export async function checkVectorizeHealth(env: Env): Promise<VectorizeHealth> {
  try {
    const info = (await env.VECTORIZE.describe()) as any;
    // `vectorsCount` is the beta spelling of V2's `vectorCount`; accept either.
    const count = info?.vectorCount ?? info?.vectorsCount;
    const name = info?.name;
    return {
      ok: true,
      indexName: typeof name === "string" && name ? name : FALLBACK_VECTORIZE_INDEX_NAME,
      dimensions: info?.dimensions ?? info?.config?.dimensions,
      vectorCount: typeof count === "number" ? count : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      indexName: FALLBACK_VECTORIZE_INDEX_NAME,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
