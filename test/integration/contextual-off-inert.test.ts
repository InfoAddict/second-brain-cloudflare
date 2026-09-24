/**
 * Contextual embeddings ship off. Off must be inert: the same vectors and
 * requests as before the feature existed, and no migration, ledger, index-size
 * read or generated-context work.
 */
import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV } from "../helpers/make-env";
import { DEFAULTS } from "../../src/config";
import { storeEntry } from "../../src/capture/store";
import { checkDuplicateAndContradiction } from "../../src/capture/duplicate";
import { SCHEME_MIGRATION_KEY, CONTEXT_LLM_BACKFILL_KV_KEY } from "../../src/migration/embedding";
import { chunkText } from "../../src/text/chunk";
import { WRITE_PATH_TOPK } from "../../src/constants";
import { neighborsFromVectorQuery } from "../../src/graph/traverse";
import type { Env } from "../../src/env";

const note = `Fuse box notes. ${Array.from({ length: 120 }, (_, i) => `Before we broke for tea, Karin brought up the rota again, and Petra mentioned the cable for the ${i % 3 ? "third" : "second"} time.`).join(" ")}`;

function makeEnv() {
  const d1 = makeSqliteD1();
  const kv = makeMemoryKV();
  const embeds: string[] = [];
  const upserts: { id: string; metadata: Record<string, any> }[] = [];
  const env = {
    DB: d1.db, OAUTH_KV: kv, AUTH_TOKEN: "t", VECTORIZE_GRACE_MS: "0",
    AI: { run: vi.fn(async (_m: string, input: { text: string[] }) => { embeds.push(input.text[0]); return { data: [[0.1, 0.2, 0.3]] }; }) },
    VECTORIZE: {
      upsert: vi.fn(async (vs: typeof upserts) => { upserts.push(...vs); return { count: vs.length }; }),
      query: vi.fn(async () => ({ matches: [] })),
      describe: vi.fn(async () => ({ vectorCount: 5, dimensions: 384 })),
      deleteByIds: vi.fn(),
    },
  } as unknown as Env;
  return { env, d1, kv, embeds, upserts };
}

describe("contextual embeddings off (the shipped default)", () => {
  it("ships off, with the generated tier off too", () => {
    expect(DEFAULTS.CONTEXTUAL_EMBEDDINGS).toBe("off");
    expect(DEFAULTS.CONTEXTUAL_EMBEDDING_LLM).toBe("off");
  });

  it("stores a long note as exactly the plain chunks, with no scheme fields and no index-size read", async () => {
    const { env, embeds, upserts } = makeEnv();
    await storeEntry(env, "n", note, ["t"], "api", 1);
    expect(embeds).toEqual(chunkText(note));
    for (const v of upserts) {
      expect(Object.keys(v.metadata).filter(k => ["scheme", "contextualized", "contextSource"].includes(k))).toEqual([]);
      expect(v.metadata.content).toBe(embeds[upserts.indexOf(v)]);
    }
    expect(upserts.map(v => v.id)).toEqual(chunkText(note).map((_, i, a) => (a.length === 1 ? "n" : `n-chunk-${i}`)));
    expect(env.VECTORIZE.describe).not.toHaveBeenCalled();
  });

  it("checks a long capture for duplicates with one embedding, as before", async () => {
    const { env, embeds } = makeEnv();
    await checkDuplicateAndContradiction(note, env);
    expect(embeds).toHaveLength(1);
    expect(env.VECTORIZE.describe).not.toHaveBeenCalled();
  });

  it("issues the duplicate check's one Vectorize query with exactly the shipped shape: topK 20 with metadata, nothing else", async () => {
    const { env } = makeEnv();
    await checkDuplicateAndContradiction(note, env);
    const query = env.VECTORIZE.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual({ topK: WRITE_PATH_TOPK, returnMetadata: "all" });
  });

  it("issues the graph neighbor query with the same shape", async () => {
    const { env } = makeEnv();
    await neighborsFromVectorQuery([0.1, 0.2, 0.3], env);
    const query = env.VECTORIZE.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual({ topK: WRITE_PATH_TOPK, returnMetadata: "all" });
  });

  it("scopes the duplicate query by workspace exactly as before when a workspace is given, still with one call and one embed", async () => {
    const { env, embeds } = makeEnv();
    await checkDuplicateAndContradiction(note, env, DEFAULTS, "w-team");
    const query = env.VECTORIZE.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toMatchObject({ topK: WRITE_PATH_TOPK, filter: { workspace_id: expect.anything() } });
    expect(embeds).toHaveLength(1);
  });

  it("runs no migration and writes no ledger from the hourly or nightly cron", async () => {
    const { default: worker } = await import("../../src/index");
    const { INTEGRATION_SYNC_CRON } = await import("../../src/integrations/mirror");
    const { env, d1, kv, embeds } = makeEnv();
    d1.seed({ id: "long", content: note, createdAt: 1 });
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
    for (const cron of [INTEGRATION_SYNC_CRON, "0 1 * * *"]) {
      await worker.scheduled({ cron, scheduledTime: Date.now() } as unknown as ScheduledEvent, env, ctx);
      await Promise.allSettled(waits);
    }
    expect(await kv.get(SCHEME_MIGRATION_KEY)).toBeNull();
    expect(await kv.get(CONTEXT_LLM_BACKFILL_KV_KEY)).toBeNull();
    expect(embeds.filter(t => t.startsWith("[Memory: "))).toEqual([]);
    expect(env.VECTORIZE.describe).not.toHaveBeenCalled();
  });
});

describe("the hourly cron reads config once", () => {
  it("resolves config a single time for the sync, the push pass over every workspace and the scheme batch", async () => {
    const { default: worker } = await import("../../src/index");
    const { INTEGRATION_SYNC_CRON } = await import("../../src/integrations/mirror");
    const { env, d1, kv } = makeEnv();
    // two workspaces with push subscriptions: the push pass used to resolve config once per workspace
    for (const ws of ["w-a", "w-b"]) d1.db.prepare(`INSERT INTO push_subscriptions (id, workspace_id, endpoint_hash, subscription_json, created_at) VALUES (?, ?, ?, '{}', 1)`).bind(`s-${ws}`, ws, `h-${ws}`).run();
    const get = vi.spyOn(kv, "get");
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
    await worker.scheduled({ cron: INTEGRATION_SYNC_CRON, scheduledTime: Date.now() } as unknown as ScheduledEvent, env, ctx);
    await Promise.allSettled(waits);
    expect(get.mock.calls.filter(c => String(c[0]) === "config:overrides")).toHaveLength(1);
  });
});
