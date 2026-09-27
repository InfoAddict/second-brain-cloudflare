import { createHash } from "node:crypto";
import type { GoldRef, GoldenQuery } from "../types";
import { ACTORS, DAY_MS, EVAL_NOW, WORKSPACES, type CorpusEdge, type CorpusEntry, type CorpusSpec } from "./types";

export const SEED = 40891;

export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

export const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)];

/** Deterministic pseudo-words: distinct, pronounceable, and absent from ordinary English, so each names one subject. */
export function pseudoWords(count: number, seed: number): string[] {
  const rand = rng(seed);
  const onsets = ["b", "br", "d", "dr", "f", "g", "gl", "k", "kr", "l", "m", "n", "p", "pr", "r", "s", "st", "t", "tr", "v", "z"];
  const vowels = ["a", "e", "i", "o", "u", "ae", "io"];
  const codas = ["l", "n", "r", "x", "m", "th", "s", "k"];
  const out = new Set<string>();
  while (out.size < count) {
    const word = pick(rand, onsets) + pick(rand, vowels) + pick(rand, codas) + pick(rand, onsets) + pick(rand, vowels) + pick(rand, ["", "n", "s", "r"]);
    out.add(word[0].toUpperCase() + word.slice(1));
  }
  return [...out];
}

export const utc = (month: number, day: number, year = 2026) => Date.UTC(year, month - 1, day);
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function entry(id: string, content: string, o: Partial<CorpusEntry> & { ageDays?: number } = {}): CorpusEntry {
  const { ageDays, ...rest } = o;
  return { id, content, tags: [], source: "api", createdAt: EVAL_NOW - (ageDays ?? 30) * DAY_MS, workspaceId: WORKSPACES.avery, actorId: ACTORS.avery, ...rest };
}

export function query(id: string, category: GoldenQuery["category"], text: string, gold: (string | GoldRef)[], extra: Partial<GoldenQuery> = {}): GoldenQuery {
  return { id, category, text, gold: gold.map(g => (typeof g === "string" ? { id: g, grade: 2 } : g)), viewer: "avery", ...extra };
}

export function edge(source: string, target: string, type: CorpusEdge["type"] = "supersedes"): CorpusEdge {
  return { id: `edge-${type}-${source}-${target}`, sourceId: source, targetId: target, type, weight: 1, provenance: "explicit", workspaceId: WORKSPACES.avery };
}

export function finish(id: string, seed: number, entries: CorpusEntry[], queries: GoldenQuery[], edges: CorpusEdge[] = [], intent: CorpusSpec["intent"] = "tie"): CorpusSpec {
  const hash = createHash("sha256").update(JSON.stringify({ seed, entries, queries, edges })).digest("hex");
  return { id, intent, entries, edges, queries, dataFingerprint: { [`synthetic:${id}`]: hash } };
}
