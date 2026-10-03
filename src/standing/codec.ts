/**
 * The standing cache's on-disk shape (Design 2.3). Holds ids, project scopes and vectors only, never memory
 * text (P7.4): a stale cache can then never render a stopped, forgotten, deprecated, moved or held memory,
 * because the text that fires is always re-read from D1 at hydration time.
 */
export interface StandingCacheItem {
  id: string;
  /** Lowercase project slugs from `project:<slug>` tags. Empty means the item fires in any recall. */
  projects: string[];
  createdAt: number;
  /** Base64, little-endian float32, one per chunk (at most 2). */
  vecs: string[];
}

export interface StandingCacheV1 {
  v: 1;
  /** cfg.EMBEDDING_MODEL at build time. */
  model: string;
  dim: number;
  builtAt: number;
  /** Set when a vector was not yet readable at build time; revalidate after this. */
  retryAt?: number;
  items: StandingCacheItem[];
}

/** Base64-encodes a vector as little-endian float32 bytes. */
export function encodeVector(values: ArrayLike<number>): string {
  const f32 = Float32Array.from(values);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Decodes a vector encoded by {@link encodeVector}. Throws on a byte length that is not float32-aligned. */
export function decodeVector(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength % 4 !== 0) throw new Error(`decodeVector: ${bytes.byteLength} bytes is not float32-aligned`);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Parses a raw KV value as a StandingCacheV1. A model or dimension mismatch against `expected` is treated as
 * "no cache" (Design 2.3): the caller rebuilds rather than trusting vectors from a different embedding space.
 */
export function parseStandingCache(raw: unknown, expected: { model: string; dim: number }): StandingCacheV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Partial<StandingCacheV1>;
  if (v.v !== 1 || typeof v.model !== "string" || typeof v.dim !== "number" || !Array.isArray(v.items) || typeof v.builtAt !== "number") return null;
  if (v.model !== expected.model || v.dim !== expected.dim) return null;
  return v as StandingCacheV1;
}
