// Track 3 (provenance and trust): pure ranking-side logic that never touches
// D1, Vectorize or the model. 16-t3-t4-trust-spec.md section 4.
import { MIRRORED_SOURCES, TRANSCRIPT_SOURCES } from "../constants";
import type { Config } from "../config";

export type SourceClass = "mirror" | "transcript" | "system" | "direct";

/** Extra MMR depth requested when the collapse or the occupancy cap is active, so there is something to promote into a freed position (4.3). */
export const CAP_LOOKAHEAD = 5;

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

// ── Lifts: shared by the occupancy cap (4.3) and the near-duplicate collapse
// (4.4). A query or tag filter naming its own source turns either defence
// off for that one call, so a deliberate "show me my email" is never thinned. ──

/** Words whose presence in the query names a source class outright (4.3). Matched on word boundaries, case-insensitive. */
export const SOURCE_LIFT_WORDS: readonly string[] = [
  "email", "e-mail", "mail", "inbox", "gmail", "outlook", "icloud",
  "calendar", "meeting", "invite", "event",
  "notion", "obsidian",
  "commit", "git",
  "transcript", "session", "conversation", "chat", "codex", "cursor", "claude code",
];

/**
 * Finance words that legitimately want mail (the Aug 16 diagnosis). A second
 * list because they lift only if the eval shows they help (11.2, grid axis
 * L) — off by default, unlike SOURCE_LIFT_WORDS.
 */
export const TRANSACTIONAL_LIFT_WORDS: readonly string[] = [
  "deposit", "payment", "statement", "invoice", "receipt", "bill", "order", "booking", "flight", "prescription",
];

/** Tags a mirror write sets on its own rows (src/integrations/{email,calendar,notion}.ts), enumerated by Task R4. */
export const MIRROR_WRITTEN_TAGS: ReadonlySet<string> = new Set(["email", "calendar", "notion"]);

/** Intent words that ask for a rollup rather than one item — the collapse's extra lift condition (4.4). */
export const ENUMERATE_RE = /\b(all|every|each|list|show|how many|history of)\b/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordBoundaryRe = (words: readonly string[]) => new RegExp(`\\b(${words.map(escapeRe).join("|")})\\b`, "i");
const SOURCE_LIFT_RE = wordBoundaryRe(SOURCE_LIFT_WORDS);
const TRANSACTIONAL_LIFT_RE = wordBoundaryRe(TRANSACTIONAL_LIFT_WORDS);

/** True when the query names a source class by word. `includeTransactional` gates the finance-word list (off by default). */
export function sourceWordLift(query: string, includeTransactional = false): boolean {
  return SOURCE_LIFT_RE.test(query) || (includeTransactional && TRANSACTIONAL_LIFT_RE.test(query));
}

/** True when a tag filter's value is itself a source-lift word, or a tag mirror writes set on their own rows. */
export function tagLift(tagFilter: string | undefined): boolean {
  if (!tagFilter) return false;
  const lower = tagFilter.toLowerCase();
  return SOURCE_LIFT_RE.test(lower) || MIRROR_WRITTEN_TAGS.has(lower);
}

/** The collapse's lift (4.4): a source word, a mirror tag filter, or an enumerating query. A `project` filter never lifts, so it is not a parameter here. */
export function collapseLift(query: string, tagFilter: string | undefined): boolean {
  return sourceWordLift(query) || tagLift(tagFilter) || ENUMERATE_RE.test(query);
}

// ── Near-duplicate collapse (4.4) ──

/**
 * A first non-empty line, lowercased, with amounts/dates/digits/ids folded to
 * `#`, then whitespace collapsed and the source appended. Two mail rows with
 * the same signature are the same recurring notice at different moments.
 */
export function templateSignature(content: string, source: string | undefined): string {
  const lines = content.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  let line = lines[0] ?? "";
  if (/^from:/i.test(line)) {
    const subject = lines.find(l => /^subject:/i.test(l));
    if (subject) line = subject;
  }
  let sig = line.toLowerCase();
  // Currency amounts first, while the digits are still intact: "$1,234.56", "€12".
  sig = sig.replace(/[$€£]\s?\d[\d,]*(\.\d+)?/g, "#");
  // ISO dates: "2026-08-11".
  sig = sig.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "#");
  // Spelled dates: "Aug 11", "Sep 3rd".
  sig = sig.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b/g, "#");
  // Slash dates: "11/08", "12/25/2026".
  sig = sig.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, "#");
  // Reference/order ids: 6+ alphanumerics containing at least one digit.
  sig = sig.replace(/\b(?=[a-z0-9]*\d)[a-z0-9]{6,}\b/g, "#");
  // Whatever digits remain (short amounts, counts).
  sig = sig.replace(/\d+/g, "#");
  sig = sig.replace(/\s+/g, " ").trim();
  return `${sig}|${source ?? ""}`;
}

export interface CollapseCandidate {
  id: string;
  content: string;
  source: string | undefined;
  tags: readonly string[];
  createdAt: number;
}

export interface CollapseSimilar {
  id: string;
  createdAt: number;
}

export interface CollapseResult<T> {
  /** The input, minus every row a signature match displaced. Order preserved. */
  kept: T[];
  /** The survivor's id maps to up to 5 displaced rows, newest first. */
  similarById: Map<string, CollapseSimilar[]>;
}

/**
 * Groups mirror-class candidates by template signature, keeps the first
 * (best-ranked) member of each group of 2 or more, and records the rest as
 * `similar` on the survivor. Never drops a non-mirror row, and never shortens
 * the list below what it was given: it only ever removes duplicates, and the
 * caller refills freed positions from its own lookahead (4.4, 4.5).
 */
export function collapseNearDuplicates<T extends CollapseCandidate>(candidates: readonly T[]): CollapseResult<T> {
  const groups = new Map<string, number[]>();
  candidates.forEach((c, i) => {
    if (sourceClass(c.source, c.tags) !== "mirror") return;
    const sig = templateSignature(c.content, c.source);
    const arr = groups.get(sig);
    if (arr) arr.push(i); else groups.set(sig, [i]);
  });
  const dropped = new Set<number>();
  const similarById = new Map<string, CollapseSimilar[]>();
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const [keepIdx, ...restIdx] = idxs;
    const kept = candidates[keepIdx];
    const similar = restIdx
      .map(i => candidates[i])
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5)
      .map(c => ({ id: c.id, createdAt: c.createdAt }));
    similarById.set(kept.id, similar);
    for (const i of restIdx) dropped.add(i);
  }
  const kept = candidates.filter((_, i) => !dropped.has(i));
  return { kept, similarById };
}
