import type { Env } from "../env";
import { VECTORIZE_GET_BY_IDS_BATCH, VECTORIZE_UPSERT_BATCH } from "../constants";

/** Vector ids an entry claims as its own: what its row lists, an upload it made, or ids derived for it. */
export interface OwnedVectors { entryId: string; vectorIds: readonly string[] }

/**
 * The only way this codebase deletes vectors (T-0089.1.1). A vector is deleted only if its own
 * metadata.parentId names an entry that claims it: entry ids are arbitrary, so a 3.7 id like
 * `x-chunk-0` can be another entry's vector id too, and a name alone never proves ownership. A
 * vector with no parentId (written before that field existed) is deleted only under the claiming
 * entry's own id, the one name that could only ever have been that entry's single vector.
 * Reads in batches of VECTORIZE_GET_BY_IDS_BATCH (Vectorize's getByIds limit); ids already gone are skipped.
 */
export async function deleteEntryVectors(env: Env, owned: readonly OwnedVectors[]): Promise<void> {
  const claimants = new Map<string, Set<string>>();
  for (const o of owned) for (const v of o.vectorIds) (claimants.get(v) ?? claimants.set(v, new Set()).get(v)!).add(o.entryId);
  const ids = [...claimants.keys()];
  if (!ids.length) return;
  const doomed: string[] = [];
  for (let i = 0; i < ids.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
    const found = await env.VECTORIZE.getByIds(ids.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH));
    for (const v of found) {
      const parentId = (v.metadata as { parentId?: unknown } | undefined)?.parentId;
      const owners = claimants.get(v.id);
      if (!owners) continue;
      if (typeof parentId === "string" ? owners.has(parentId) : owners.has(v.id)) doomed.push(v.id);
    }
  }
  for (let i = 0; i < doomed.length; i += VECTORIZE_UPSERT_BATCH) await env.VECTORIZE.deleteByIds(doomed.slice(i, i + VECTORIZE_UPSERT_BATCH));
}
