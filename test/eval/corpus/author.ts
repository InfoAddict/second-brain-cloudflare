import type { GoldenQuery } from "../types";
import { COMMON_TOKENS } from "./haystack";
import type { NeedleRow } from "./types";

/** Needles at least this old get a second, common-token-prefixed query: the shape that exposes LIKE's newest-500 window. */
export const OLD_NEEDLE_DAYS = 450;

/**
 * Identifier and rare-word queries, built only from a needle's declared keys.
 * Every keyed needle gets the key alone; old ones also get "roadmap <key>", the only common
 * token dense enough at every scale to push an old needle out of the LIKE window.
 */
export function mechanicalQueries(needles: readonly NeedleRow[]): GoldenQuery[] {
  const decoyed = new Set(needles.filter(n => n.id.endsWith("-decoy")).map(n => n.id.replace(/-decoy$/, "")));
  const counters = { identifier: 0, "rare-word": 0 };
  const out: GoldenQuery[] = [];
  for (const needle of needles) {
    if (needle.id.endsWith("-decoy") || !needle.keys?.length) continue;
    if (needle.purpose !== "identifier" && needle.purpose !== "rare-word") continue;
    const n = ++counters[needle.purpose];
    const id = `${needle.purpose === "identifier" ? "q-id" : "q-rare"}-${String(n).padStart(3, "0")}`;
    const key = needle.keys[0];
    const byBlake = needle.purpose === "identifier" && needle.workspace === "company" && n % 2 === 1;
    const shared = {
      category: needle.purpose,
      gold: [{ id: needle.id, grade: 2 as const }],
      viewer: byBlake ? ("blake" as const) : ("avery" as const),
      ...(byBlake ? { layer: "company" as const } : {}),
      ...(decoyed.has(needle.id) ? { tags: ["tenancy"] } : {}),
    };
    out.push({ id, text: key, ...shared });
    if (needle.ageDays >= OLD_NEEDLE_DAYS) {
      out.push({ id: `${id}-c`, text: `${COMMON_TOKENS[0]} ${key}`, ...shared });
    }
  }
  return out;
}
