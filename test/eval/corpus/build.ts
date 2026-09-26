import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EdgeType } from "../../../src/graph/types";
import type { GoldenQuery } from "../types";
import { hashDataDir } from "../lock";
import { CORRELATED_RATE_BY_SCALE, DENSE_RATE_BY_SCALE, DENSE_TOKENS, generateHaystack } from "./haystack";
import {
  ACTORS, EVAL_NOW, WORKSPACES, needleToEntry,
  type CorpusEdge, type CorpusEntry, type CorpusSpec, type NeedleRow,
} from "./types";

export const CORPUS_IDS = ["core-1k", "scale-5k", "scale-20k"] as const;
export type CoreCorpusId = (typeof CORPUS_IDS)[number];

/**
 * Haystack rows per scale. The needles come on top, so the golden set can grow without changing the
 * haystack (and the density bands its rates were solved for). "1k" names the haystack scale, not the total.
 */
export const HAYSTACK_ROWS = { "core-1k": 656, "scale-5k": 4656, "scale-20k": 19656 } as const;

export const CORPUS_PARAMS: Record<CoreCorpusId, { intent: CorpusSpec["intent"]; haystack: number; commonRate: number; seed: number; denseRate: (typeof DENSE_RATE_BY_SCALE)[keyof typeof DENSE_RATE_BY_SCALE]; correlatedRate: number }> = {
  "core-1k": { intent: "tie", haystack: HAYSTACK_ROWS["core-1k"], commonRate: 0.25, seed: 1001, denseRate: DENSE_RATE_BY_SCALE["1k"], correlatedRate: CORRELATED_RATE_BY_SCALE["1k"] },
  "scale-5k": { intent: "discriminate", haystack: HAYSTACK_ROWS["scale-5k"], commonRate: 0.25, seed: 5001, denseRate: DENSE_RATE_BY_SCALE["5k"], correlatedRate: CORRELATED_RATE_BY_SCALE["5k"] },
  // 0.08 keeps a rare+common query under the router's FTS budget at 20k
  "scale-20k": { intent: "discriminate", haystack: HAYSTACK_ROWS["scale-20k"], commonRate: 0.08, seed: 20001, denseRate: DENSE_RATE_BY_SCALE["20k"], correlatedRate: CORRELATED_RATE_BY_SCALE["20k"] },
};

export interface EdgeRow { source: string; target: string; type: EdgeType; weight: number; provenance: "explicit" | "inferred" | "system" }

const ROOT = process.env.SB_EVAL_ROOT ?? resolve(import.meta.dirname, "../../..");
export const CORE_DATA_DIR = resolve(ROOT, "test/eval/data/core");

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as T);
}

/**
 * A long, topically coherent haystack row (ids h-long-NNN). They exist so that note length does not identify a needle:
 * the coherent long-context needles are far longer than every other needle, and a dense retriever ranks long,
 * diffuse text into short queries' top ten. No query asks for anything in these rows.
 */
export type LongHaystackRow = Pick<NeedleRow, "id" | "content" | "workspace" | "actor" | "ageDays" | "importance">;

export interface CoreData { needles: NeedleRow[]; edges: EdgeRow[]; queries: GoldenQuery[]; haystack?: LongHaystackRow[] }

export function loadCoreData(): CoreData {
  return {
    needles: readJsonl<NeedleRow>(resolve(CORE_DATA_DIR, "needles.jsonl")),
    edges: readJsonl<EdgeRow>(resolve(CORE_DATA_DIR, "edges.jsonl")),
    queries: readJsonl<GoldenQuery>(resolve(CORE_DATA_DIR, "queries.jsonl")),
    haystack: existsSync(resolve(CORE_DATA_DIR, "haystack.jsonl")) ? readJsonl<LongHaystackRow>(resolve(CORE_DATA_DIR, "haystack.jsonl")) : [],
  };
}

/** `data` overrides the committed files (the audit tool and tests build candidate sets this way). */
/**
 * Queries that share a source memory resample together. A common-word query is identified by its dense triple, and the
 * same triple in two viewer scopes is two notes with near-identical embeddings, so a triple is one cluster however
 * many notes carry it.
 */
export function clusterKeyOf(q: GoldenQuery): string {
  if (q.category === "common-word") {
    const triple = q.text.split(/\s+/).filter(word => (DENSE_TOKENS as readonly string[]).includes(word)).sort();
    if (triple.length === 3) return `triple:${triple.join(",")}`;
  }
  return q.gold.find(g => g.grade === 2)?.id ?? q.gold[0].id;
}

export function buildCorpus(id: CoreCorpusId, data: CoreData = loadCoreData()): CorpusSpec {
  const params = CORPUS_PARAMS[id];
  const { needles, edges, queries } = data;
  const needleEntries = needles.map(needleToEntry);
  const haystack: CorpusEntry[] = generateHaystack({
    count: params.haystack,
    seed: params.seed,
    commonRate: params.commonRate,
    denseRate: params.denseRate,
    correlatedRate: params.correlatedRate,
    idPrefix: "f",
    now: EVAL_NOW,
    spanDays: 730,
    cjkRate: 0.08,
    longRate: 0.02,
    workspaces: [
      { workspaceId: WORKSPACES.avery, actorId: ACTORS.avery, weight: 45 },
      { workspaceId: WORKSPACES.company, actorId: ACTORS.blake, weight: 45 },
      { workspaceId: WORKSPACES.blake, actorId: ACTORS.blake, weight: 10 },
    ],
  });
  const longHaystack = (data.haystack ?? []).map(row => needleToEntry({ ...row, tags: [] }));
  // Inserted oldest first, so rowids follow time as they do on a real brain (the keyword AND tier scans the
  // index newest-first by rowid); ties keep authored order.
  const entries = [...needleEntries, ...haystack, ...longHaystack]
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => a.entry.createdAt - b.entry.createdAt || a.order - b.order)
    .map(({ entry }) => entry);
  const workspaceOf = new Map(entries.map(e => [e.id, e.workspaceId] as const));
  const corpusEdges: CorpusEdge[] = edges.map((e, i) => ({
    id: `edge-${i}`, sourceId: e.source, targetId: e.target, type: e.type, weight: e.weight, provenance: e.provenance,
    workspaceId: workspaceOf.get(e.source) ?? "",
  }));
  return {
    id,
    intent: params.intent,
    entries,
    edges: corpusEdges,
    queries: queries.map(q => ({ ...q, clusterKey: q.clusterKey ?? clusterKeyOf(q) })),
    dataFingerprint: hashDataDir(CORE_DATA_DIR),
  };
}
