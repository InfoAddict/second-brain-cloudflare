/**
 * How much of the free plan's Vectorize storage focus chunking may use.
 *
 * Focus chunks (see contextual.ts) turn a long note into about 2.4 times as many
 * vectors as before. That is what makes a buried fact findable, but on the free
 * plan's 5M stored dimensions (about 13,000 bge-small vectors) a brain made
 * mostly of long notes would run out of room noticeably sooner. So focus mode
 * is a budget, not a promise: while the index holds fewer stored dimensions than
 * CONTEXTUAL_FOCUS_DIMENSION_BUDGET, long notes get focus chunks; past it they
 * are chunked at the larger tail size, which grows the index about as fast as
 * plain chunking always did. A brain that never gets near the budget never
 * notices; one that does keeps most of its capacity. Set the budget to 0 to
 * remove the limit (paid plans have room to spare).
 */
import type { Config } from "../config";
import type { Env } from "../env";

const CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 60_000;
/** The last answer (a size, or null for "could not read it") and when it was given; and the read now in flight, so captures that arrive together share it. */
let cached: { at: number; dims: number | null } | null = null;
let inFlight: Promise<number | null> | null = null;
/** Bumped by a reset, so a read that started before it cannot write its answer into the cache after it. */
let generation = 0;

/** For tests: forgets the remembered index size. */
export function resetFocusBudgetCache(): void {
  cached = null;
  inFlight = null;
  generation++;
}

async function readStoredDimensions(env: Env): Promise<number | null> {
  try {
    // V2 indexes report { vectorCount, dimensions }; the generated V1 type says { vectorsCount, config.dimensions }.
    const info = (await env.VECTORIZE.describe()) as unknown as Record<string, any> | undefined;
    const count = info?.vectorCount ?? info?.vectorsCount;
    const dims = info?.dimensions ?? info?.config?.dimensions;
    return typeof count === "number" && typeof dims === "number" ? count * dims : null;
  } catch {
    return null;
  }
}

/**
 * Stored dimensions in the index right now, remembered per isolate for five
 * minutes, and a failed read for one, so a broken `describe` is not retried on
 * every long capture; concurrent callers share one read. Null when it cannot be read.
 */
async function storedDimensions(env: Env): Promise<number | null> {
  const now = Date.now();
  if (cached && now - cached.at < (cached.dims === null ? FAILURE_CACHE_MS : CACHE_MS)) return cached.dims;
  if (!inFlight) {
    const mine = generation;
    const read: Promise<number | null> = readStoredDimensions(env).then(dims => {
      if (mine === generation) cached = { at: Date.now(), dims };
      return dims;
    }).finally(() => { if (inFlight === read) inFlight = null; });
    inFlight = read;
  }
  return inFlight;
}

/** True when a long note may be cut into focus chunks. Fails open: an unreadable index size never costs a save its quality. */
export async function focusModeAllowed(env: Env, config: Readonly<Config>): Promise<boolean> {
  const budget = config.CONTEXTUAL_FOCUS_DIMENSION_BUDGET;
  if (budget <= 0) return true;
  const used = await storedDimensions(env);
  return used === null || used < budget;
}
