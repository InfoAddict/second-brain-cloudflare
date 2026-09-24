import type { Env } from "../env";
import { VECTORIZE_UPSERT_BATCH } from "../constants";

/** Deletes vectors in calls of at most VECTORIZE_UPSERT_BATCH ids, the same ceiling upserts are held to. */
export async function deleteVectorIds(env: Env, ids: readonly string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += VECTORIZE_UPSERT_BATCH) await env.VECTORIZE.deleteByIds(ids.slice(i, i + VECTORIZE_UPSERT_BATCH) as string[]);
}
