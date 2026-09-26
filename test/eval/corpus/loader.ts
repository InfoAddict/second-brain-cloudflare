import { normalizeCaptureInput } from "../../../src/capture/entry";
import { storeEntry } from "../../../src/capture/store";
import { DEFAULTS } from "../../../src/config";
import { FTS_READY_KV_KEY } from "../../../src/constants";
import { initializeDatabase, resetDatabaseInit } from "../../../src/db/init";
import type { Env } from "../../../src/env";
import { resetFtsReadyMemo } from "../../../src/recall/fts";
import { makeMemoryKV } from "../../helpers/make-env";
import { EMBEDDING_DIMS, type ReplayAi } from "../ai-replay";
import { openD1, type EvalD1 } from "../d1";
import { ExactVectorize } from "../vectorize-emulator";
import type { CorpusSpec } from "./types";

// The classifier's own fallback (src/capture/classify.ts); 0 would switch off a live ranking signal.
const DEFAULT_IMPORTANCE = 3;

/** Index-time variant hook: a variant that changes how entries are indexed supplies its own storeEntry here. */
export interface IndexVariant { id: string; storeEntry: typeof storeEntry }

export interface LoadedCorpus {
  id: string;
  dataFingerprint?: Record<string, string>;
  /** Which index-time variant built the vectors ("shipped" = the real storeEntry). */
  indexId: string;
  env: Env;
  d1: EvalD1;
  vectorize: ExactVectorize;
  replay: ReplayAi;
  workspaceOf: Map<string, string>;
  entryCount: number;
  close(): Promise<void>;
}

export async function loadCorpus(o: {
  spec: CorpusSpec;
  backend: "sqlite" | "workerd";
  replay: ReplayAi;
  embeddingModel: string;
  index?: IndexVariant;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<LoadedCorpus> {
  const dimensions = EMBEDDING_DIMS[o.embeddingModel];
  if (!dimensions) throw new Error(`no known embedding dimensions for ${o.embeddingModel}`);
  for (const e of o.spec.entries) {
    if (e.importanceScore !== undefined && !(Number.isInteger(e.importanceScore) && e.importanceScore >= 1 && e.importanceScore <= 5)) {
      throw new Error(`entry ${e.id}: importanceScore must be an integer 1-5, got ${e.importanceScore}`);
    }
  }
  // Same normalization captureEntry applies; the rows and the vectors both use the normalized form.
  const entries = o.spec.entries.map(e => ({ ...e, ...normalizeCaptureInput(e.content, e.tags) }));
  const d1 = await openD1(o.backend);
  try {
    const kv = makeMemoryKV();
    const vectorize = new ExactVectorize({ dimensions });
    const env = {
      DB: d1.db, OAUTH_KV: kv, VECTORIZE: vectorize as unknown as VectorizeIndex, AI: o.replay.ai, AUTH_TOKEN: "eval", VECTORIZE_GRACE_MS: "0",
    } as unknown as Env;
    resetDatabaseInit();
    resetFtsReadyMemo();
    await initializeDatabase(env);

    const { edges } = o.spec;
    for (let i = 0; i < entries.length; i += 100) {
      await env.DB.batch(entries.slice(i, i + 100).map(e =>
        env.DB.prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, importance_score, workspace_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
        ).bind(e.id, e.content, JSON.stringify(e.tags), e.source, e.createdAt, e.createdAt, e.importanceScore ?? DEFAULT_IMPORTANCE, e.workspaceId, e.actorId)));
    }

    // The real write path: chunking, embedding, Vectorize metadata, entries.vector_ids.
    const write = o.index?.storeEntry ?? storeEntry;
    const cfg = Object.freeze({ ...DEFAULTS, EMBEDDING_MODEL: o.embeddingModel });
    let done = 0;
    const queue = [...entries];
    await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 1) }, async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        await write(env, e.id, e.content, e.tags, e.source, e.createdAt, cfg, { workspaceId: e.workspaceId, actorId: e.actorId });
        o.onProgress?.(++done, entries.length);
      }
    }));

    for (let i = 0; i < edges.length; i += 100) {
      await env.DB.batch(edges.slice(i, i + 100).map(x =>
        env.DB.prepare(
          `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, '{}', 1, 1, ?)`,
        ).bind(x.id, x.sourceId, x.targetId, x.type, x.weight, x.provenance, x.workspaceId)));
    }

    // Parity first, then the ready flag: the index and counters must equal the table before recall trusts them.
    const parity = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM entries) AS e, (SELECT count(*) FROM entries_fts) AS f, (SELECT COALESCE(SUM(n), 0) FROM entry_counts) AS c`,
    ).first<{ e: number; f: number; c: number }>();
    if (!parity || parity.e !== entries.length || parity.f !== parity.e || parity.c !== parity.e) {
      throw new Error(`corpus ${o.spec.id}: index drift after load ${JSON.stringify(parity)} (expected ${entries.length})`);
    }
    await kv.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();

    return {
      id: o.spec.id, dataFingerprint: o.spec.dataFingerprint, indexId: o.index?.id ?? "shipped", env, d1, vectorize, replay: o.replay,
      workspaceOf: new Map(entries.map(e => [e.id, e.workspaceId] as const)),
      entryCount: entries.length,
      close: () => d1.close(),
    };
  } catch (e) {
    await d1.close();
    throw e;
  }
}
