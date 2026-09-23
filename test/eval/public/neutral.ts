// Adapter over a neutral local layout (corpus.jsonl, queries.jsonl, qrels.tsv) under .eval-cache/public/<id>/.
// Nothing here is committed: scripts/eval-fetch-public.mjs downloads and normalizes on demand.
//
// Dataset licenses (checked Sep 23, 2026; used locally for evaluation only, never redistributed):
//  - BEIR SciFact: the BEIR bundle itself carries no license. Sources disagree: the Rahil-supplied
//    brief says CC BY-NC 2.0; allenai/scifact LICENSE.md says claims CC BY 4.0 and abstracts (S2ORC)
//    ODC-By 1.0; the BeIR/scifact HF card says CC BY-SA 4.0. Treat as the strictest (non-commercial).
//  - MIRACL (annotations, miracl/miracl) and miracl-corpus: Apache-2.0 per the HF cards; the passages
//    are Wikipedia text, so CC BY-SA 4.0 attribution terms apply to the text itself.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GoldenQuery, QueryCategory } from "../types";
import { ACTORS, DAY_MS, EVAL_NOW, WORKSPACES, type CorpusSpec } from "../corpus/types";

const jsonl = <T>(path: string): T[] => readFileSync(path, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l) as T);

/** Deterministic pseudo-age in days (0-729) from the document id. */
const ageDays = (id: string) => createHash("sha256").update(id).digest().readUInt16BE(0) % 730;

/** Every derived file must match the sha256 the fetch script recorded, so a truncated or edited file cannot pass silently. */
function verifyDerived(dir: string, id: string): Record<string, string> {
  const refetch = `re-run: node scripts/eval-fetch-public.mjs ${id}`;
  const manifestPath = join(dir, "MANIFEST.json");
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} not found (incomplete fetch); ${refetch}`);
  const derived = (JSON.parse(readFileSync(manifestPath, "utf8")) as { derived?: Record<string, string> }).derived;
  const checked: Record<string, string> = {};
  for (const file of ["corpus.jsonl", "queries.jsonl", "qrels.tsv"]) {
    const path = join(dir, file);
    const want = derived?.[file];
    if (!want) throw new Error(`MANIFEST.json has no sha256 for ${file}; ${refetch}`);
    if (!existsSync(path)) throw new Error(`${path} not found; ${refetch}`);
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== want) throw new Error(`${path} does not match MANIFEST.json (truncated or edited); ${refetch}`);
    checked[file] = want;
  }
  return checked;
}

export function loadNeutralCorpus(o: { id: string; dir: string; category: QueryCategory; maxDocs?: number; maxQueries?: number }): CorpusSpec {
  const need = (name: string) => {
    const path = join(o.dir, name);
    if (!existsSync(path)) throw new Error(`${path} not found; run: node scripts/eval-fetch-public.mjs ${o.id}`);
    return path;
  };
  const fingerprint = verifyDerived(o.dir, o.id);
  const docs = jsonl<{ id: string; text: string }>(need("corpus.jsonl"));
  const queryRows = jsonl<{ id: string; text: string }>(need("queries.jsonl"));
  const qrels = new Map<string, { id: string; grade: 1 | 2 }[]>();
  for (const line of readFileSync(need("qrels.tsv"), "utf8").split("\n")) {
    const [qid, did, score] = line.split("\t");
    if (!qid || !did || Number.isNaN(Number(score)) || Number(score) <= 0) continue; // header and zero judgments
    (qrels.get(qid) ?? qrels.set(qid, []).get(qid)!).push({ id: did, grade: Number(score) >= 2 ? 2 : 1 });
  }
  const judged = queryRows.filter(q => qrels.has(q.id)).slice(0, o.maxQueries ?? Infinity);
  const goldIds = new Set(judged.flatMap(q => qrels.get(q.id)!.map(g => g.id)));
  const known = new Set(docs.map(d => d.id));
  for (const id of goldIds) if (!known.has(id)) throw new Error(`qrels reference ${id}, which is not in corpus.jsonl`);
  const distractors = docs.filter(d => !goldIds.has(d.id));
  // Judged documents are never dropped, so maxDocs is a floor of goldIds.size.
  const kept = [...docs.filter(d => goldIds.has(d.id)), ...distractors.slice(0, Math.max(0, (o.maxDocs ?? Infinity) - goldIds.size))];
  const queries: GoldenQuery[] = judged.map(q => ({
    id: q.id, category: o.category, text: q.text, gold: qrels.get(q.id)!, viewer: "avery", tags: ["public"], clusterKey: q.id,
  }));
  return {
    id: o.id,
    intent: "discriminate", // 5,000+ docs exceed the 500-row keyword window
    entries: kept.map(d => ({ id: d.id, content: d.text, tags: [], source: "api", createdAt: EVAL_NOW - ageDays(d.id) * DAY_MS, workspaceId: WORKSPACES.avery, actorId: ACTORS.avery })),
    edges: [],
    queries,
    dataFingerprint: fingerprint, // the derived-manifest hashes: what this corpus was built from
  };
}

export interface PublicCorpusConfig {
  category: "paraphrase" | "cjk";
  maxDocs: number;
  maxQueries: number;
  /** The model the corpus must be recorded and run with (pass as --embedding-model). */
  embeddingModel: string;
}

export const PUBLIC_CORPORA: Record<string, PublicCorpusConfig> = {
  "beir-scifact": { category: "paraphrase", maxDocs: 5200, maxQueries: 1200, embeddingModel: "@cf/baai/bge-small-en-v1.5" },
  "miracl-ja": { category: "cjk", maxDocs: 13_500, maxQueries: 900, embeddingModel: "@cf/baai/bge-m3" },
};

/** Shape of registerCorpusProvider's arguments (Task 8): `registerCorpusProvider(p.name, p.match, p.build)`. */
export function publicCorpusProvider(root: string = process.env.SB_EVAL_ROOT ?? resolve(import.meta.dirname, "../../..")) {
  return {
    name: "public",
    match: (id: string) => Object.hasOwn(PUBLIC_CORPORA, id),
    build: (id: string): CorpusSpec => {
      const { embeddingModel: _model, ...cfg } = PUBLIC_CORPORA[id];
      return loadNeutralCorpus({ id, dir: resolve(root, ".eval-cache/public", id), ...cfg });
    },
  };
}
