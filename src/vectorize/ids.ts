/**
 * Vector ids (T-0089.1.1). Every upload mints its own: `<entryId>:<8 hex, per upload>:<chunk>`. Two
 * writers embedding the same entry never share an id, so a writer's cleanup can only delete ids it
 * uploaded; which upload won is decided by the row's vector_ids alone. 3.7 wrote deterministic ids
 * (`<entryId>`, `<entryId>-chunk-<i>`, `<entryId>-update-<ms>`); they stay valid with no backfill.
 * Every vector also carries `metadata.parentId`, which recall reads first.
 */
/** Vectorize rejects a vector id over 64 bytes. */
export const VECTOR_ID_MAX_BYTES = 64;
/**
 * The longest entry id any path may create an entry with: 64 bytes minus the largest upload suffix
 * (`:` + 8 hex + `:` + a 6-digit chunk index = 16; D1's 2 MB row cap means under 10,000 chunks) and
 * 8 bytes of headroom. One rule everywhere: a caller-chosen id over it gets a minted id instead.
 */
export const MAX_ENTRY_ID_BYTES = 40;

const utf8 = new TextEncoder();
const byteLength = (s: string) => utf8.encode(s).length;

/** The longest prefix of `s` within `max` UTF-8 bytes, never splitting a character. */
function bytePrefix(s: string, max: number): string {
  let out = "";
  for (const ch of s) { if (byteLength(out + ch) > max) break; out += ch; }
  return out;
}

export function newVectorIds(entryId: string, count: number): string[] {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("");
  // A 3.7-era id over the bound (no cap then) keeps a byte-safe prefix, so every vector id stays
  // under 64 bytes; metadata.parentId still names the entry in full, and recall reads that.
  const prefix = byteLength(entryId) > MAX_ENTRY_ID_BYTES ? bytePrefix(entryId, MAX_ENTRY_ID_BYTES) : entryId;
  return Array.from({ length: count }, (_, i) => `${prefix}:${suffix}:${i}`);
}

/**
 * The id an entry is created under when the caller chose `id`: `id` itself within MAX_ENTRY_ID_BYTES,
 * otherwise a minted one derived from it (SHA-256), so a re-import maps to the same id (and skips as a
 * duplicate) and an edge in the same export that names `id` finds it.
 */
export async function boundedEntryId(id: string): Promise<string> {
  if (byteLength(id) <= MAX_ENTRY_ID_BYTES) return id;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(id)));
  return "i" + Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, "0")).join("");
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
