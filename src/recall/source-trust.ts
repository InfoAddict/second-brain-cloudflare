// Track 3 (provenance and trust): pure ranking-side logic that never touches
// D1, Vectorize or the model. 16-t3-t4-trust-spec.md section 4.
import { MIRRORED_SOURCES, TRANSCRIPT_SOURCES } from "../constants";
import type { Config } from "../config";

export type SourceClass = "mirror" | "transcript" | "system" | "direct";

/**
 * First match wins: a mirror or transcript source is classified from the
 * caller-declared `source` string alone, before any tag is consulted. Reads
 * MIRRORED_SOURCES and TRANSCRIPT_SOURCES live (never copies them), so a new
 * label added to either set — the hooks lane's codex-session and
 * cursor-session, for instance — is classified with no change here.
 *
 * Honest limit: `source` is caller-declared, so this is a ranking prior, not
 * a security boundary (16-t3-t4-trust-spec.md 4.1).
 */
export function sourceClass(source: string | undefined, tags: readonly string[]): SourceClass {
  if (source !== undefined && MIRRORED_SOURCES.has(source)) return "mirror";
  if (source !== undefined && TRANSCRIPT_SOURCES.has(source)) return "transcript";
  if (tags.includes("synthesized") || tags.includes("auto-insight")) return "system";
  return "direct";
}

/** The configured demotion for a class; `direct` is always 1.0 (4.2). Callers apply the canonical override themselves. */
export function sourceWeight(cls: SourceClass, cfg: Readonly<Config>): number {
  switch (cls) {
    case "mirror": return cfg.SOURCE_WEIGHT_MIRROR;
    case "transcript": return cfg.SOURCE_WEIGHT_TRANSCRIPT;
    case "system": return cfg.SOURCE_WEIGHT_SYSTEM;
    case "direct": return 1.0;
  }
}
