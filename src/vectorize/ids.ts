/**
 * Vector ids (T-0089.1.1). Every upload mints its own: `<entryId>:<8 hex, per upload>:<chunk>`. Two
 * writers embedding the same entry never share an id, so a writer's cleanup can only delete ids it
 * uploaded; which upload won is decided by the row's vector_ids alone. 3.7 wrote deterministic ids
 * (`<entryId>`, `<entryId>-chunk-<i>`, `<entryId>-update-<ms>`); they stay valid with no backfill.
 * Every vector also carries `metadata.parentId`, which recall reads first.
 */
export function newVectorIds(entryId: string, count: number): string[] {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("");
  return Array.from({ length: count }, (_, i) => `${entryId}:${suffix}:${i}`);
}

/** The entry a vector id belongs to, for either form. */
export function parentIdOfVectorId(vectorId: string): string {
  const m = /^(.*):[0-9a-f]{8}:\d+$/.exec(vectorId) ?? /^(.*)-(?:chunk|update)-\d+$/.exec(vectorId);
  return m ? m[1] : vectorId;
}

/** A sort key for tie-breaks between matches that is the same for every upload of a chunk: the
 * entry id and chunk index, without the random per-upload suffix, so recall ordering stays stable. */
export function vectorSortKey(vectorId: string): string {
  const m = /^(.*):[0-9a-f]{8}:(\d+)$/.exec(vectorId);
  return m ? `${m[1]}:${m[2].padStart(6, "0")}` : vectorId;
}
