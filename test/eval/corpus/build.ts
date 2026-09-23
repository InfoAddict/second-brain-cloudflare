import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EdgeType } from "../../../src/graph/types";
import type { GoldenQuery } from "../types";
import { DENSE_RATE_BY_SCALE, generateHaystack } from "./haystack";
import {
  ACTORS, EVAL_NOW, WORKSPACES, needleToEntry,
  type CorpusEdge, type CorpusEntry, type CorpusSpec, type NeedleRow,
} from "./types";

export const CORPUS_IDS = ["core-1k", "scale-5k", "scale-20k"] as const;
export type CoreCorpusId = (typeof CORPUS_IDS)[number];

export const CORPUS_PARAMS: Record<CoreCorpusId, { total: number; commonRate: number; seed: number; denseRate: (typeof DENSE_RATE_BY_SCALE)[keyof typeof DENSE_RATE_BY_SCALE] }> = {
  "core-1k": { total: 1000, commonRate: 0.25, seed: 1001, denseRate: DENSE_RATE_BY_SCALE["1k"] },
  "scale-5k": { total: 5000, commonRate: 0.25, seed: 5001, denseRate: DENSE_RATE_BY_SCALE["5k"] },
  // 0.08 keeps a rare+common query under the router's FTS budget at 20k
  "scale-20k": { total: 20000, commonRate: 0.08, seed: 20001, denseRate: DENSE_RATE_BY_SCALE["20k"] },
};

export interface EdgeRow { source: string; target: string; type: EdgeType; weight: number; provenance: "explicit" | "inferred" | "system" }

const ROOT = process.env.SB_EVAL_ROOT ?? resolve(import.meta.dirname, "../../..");
export const CORE_DATA_DIR = resolve(ROOT, "test/eval/data/core");

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as T);
}

export function loadCoreData() {
  return {
    needles: readJsonl<NeedleRow>(resolve(CORE_DATA_DIR, "needles.jsonl")),
    edges: readJsonl<EdgeRow>(resolve(CORE_DATA_DIR, "edges.jsonl")),
    queries: readJsonl<GoldenQuery>(resolve(CORE_DATA_DIR, "queries.jsonl")),
  };
}

export function buildCorpus(id: CoreCorpusId): CorpusSpec {
  const params = CORPUS_PARAMS[id];
  const { needles, edges, queries } = loadCoreData();
  const needleEntries = needles.map(needleToEntry);
  const haystack: CorpusEntry[] = generateHaystack({
    count: params.total - needleEntries.length,
    seed: params.seed,
    commonRate: params.commonRate,
    denseRate: params.denseRate,
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
  const entries = [...needleEntries, ...haystack];
  const workspaceOf = new Map(entries.map(e => [e.id, e.workspaceId] as const));
  const corpusEdges: CorpusEdge[] = edges.map((e, i) => ({
    id: `edge-${i}`, sourceId: e.source, targetId: e.target, type: e.type, weight: e.weight, provenance: e.provenance,
    workspaceId: workspaceOf.get(e.source) ?? "",
  }));
  return {
    id,
    entries,
    edges: corpusEdges,
    queries: queries.map(q => ({ ...q, clusterKey: q.clusterKey ?? q.gold.find(g => g.grade === 2)?.id ?? q.gold[0].id })),
  };
}
