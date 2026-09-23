import { describe, expect, it, vi } from "vitest";
import { FTS_READY_KV_KEY } from "../../../src/constants";
import { ReplayStore, makeReplayAi } from "../ai-replay";
import { loadCorpus } from "./loader";
import { ACTORS, EVAL_NOW, WORKSPACES, type CorpusEntry, type CorpusSpec } from "./types";

const entry = (id: string, content: string, ws: keyof typeof WORKSPACES = "avery"): CorpusEntry => ({
  id, content, tags: ["t1"], source: "api", createdAt: EVAL_NOW - 1000, workspaceId: WORKSPACES[ws], actorId: ACTORS.avery,
});
const long = `${"Opening paragraph about the renovation plan. ".repeat(50)}${"Later paragraph about the panel upgrade cost. ".repeat(50)}`;
const spec: CorpusSpec = {
  id: "tiny",
  entries: [entry("a", "alpha widget plan"), entry("b", "東京の会議メモ"), entry("c", "shared note", "company"), entry("d", long)],
  edges: [{ id: "e1", sourceId: "a", targetId: "c", type: "relates_to", weight: 0.9, provenance: "explicit", workspaceId: WORKSPACES.avery }],
  queries: [],
};
const dry = () => makeReplayAi({ store: new ReplayStore([]), mode: "dry" });
const MODEL = "@cf/baai/bge-small-en-v1.5";

describe("loadCorpus (sqlite backend)", () => {
  it("indexes through the real write path: rows, FTS, counters, vectors, edges, and the ready flag", async () => {
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: dry(), embeddingModel: MODEL });
    try {
      const counts = await corpus.env.DB.prepare(
        `SELECT (SELECT count(*) FROM entries) AS e, (SELECT count(*) FROM entries_fts) AS f, (SELECT COALESCE(SUM(n), 0) FROM entry_counts) AS c, (SELECT count(*) FROM edges) AS g`,
      ).first<{ e: number; f: number; c: number; g: number }>();
      expect(counts).toEqual({ e: 4, f: 4, c: 4, g: 1 });
      const hit = await corpus.env.DB.prepare(`SELECT id FROM entries_fts WHERE entries_fts MATCH '"widget"'`).all();
      expect(hit.results).toHaveLength(1);
      expect(await corpus.env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
      // The long entry is multi-chunk, exactly as storeEntry writes it.
      const ids = (await corpus.vectorize.query(new Array(384).fill(0.01), { topK: 50, returnMetadata: "all" })).matches.map(m => m.id);
      expect(ids.filter(id => id.startsWith("d-chunk-")).length).toBeGreaterThan(1);
      const stored = await corpus.env.DB.prepare(`SELECT vector_ids FROM entries WHERE id = 'd'`).first<{ vector_ids: string }>();
      expect(JSON.parse(stored!.vector_ids).length).toBeGreaterThan(1);
      expect(corpus.workspaceOf.get("c")).toBe(WORKSPACES.company);
      expect(corpus.entryCount).toBe(4);
      expect(corpus.indexId).toBe("shipped");
    } finally {
      await corpus.close();
    }
  });

  it("stamps workspace_id on every vector so the scoped Vectorize filter can work", async () => {
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: dry(), embeddingModel: MODEL });
    try {
      const scoped = await corpus.vectorize.query(new Array(384).fill(0.01), { topK: 50, returnMetadata: "all", filter: { workspace_id: { $in: [WORKSPACES.company] } } });
      expect(scoped.matches.map(m => m.id)).toEqual(["c"]);
    } finally {
      await corpus.close();
    }
  });

  it("indexes through an index variant's storeEntry when one is supplied", async () => {
    const custom = vi.fn(async (...args: Parameters<typeof import("../../../src/capture/store").storeEntry>) => {
      const real = await import("../../../src/capture/store");
      return real.storeEntry(...args);
    });
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: dry(), embeddingModel: MODEL, index: { id: "test-variant", storeEntry: custom } });
    expect(corpus.indexId).toBe("test-variant");
    await corpus.close();
    expect(custom).toHaveBeenCalledTimes(4);
  });

  it("fails closed and releases the database when a replay miss aborts the load", async () => {
    const replay = makeReplayAi({ store: new ReplayStore([]), mode: "replay" });
    await expect(loadCorpus({ spec, backend: "sqlite", replay, embeddingModel: MODEL })).rejects.toThrow(/replay|miss/i);
  });
});
