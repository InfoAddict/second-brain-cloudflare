/**
 * T-0042: the optional generated-context tier. Off by default; when on it is
 * bounded per night, upgrades whole entries only, and a failure at any point
 * leaves the deterministic vectors in place.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV } from "../helpers/make-env";
import { DEFAULTS, type Config } from "../../src/config";
import { cleanGeneratedContext } from "../../src/capture/contextual";
import { CONTEXT_LLM_CHUNKS_PER_NIGHT } from "../../src/constants";
import { CONTEXT_LLM_BACKFILL_KV_KEY, runLlmContextBatch, runSchemeBatch } from "../../src/migration/embedding";
import { storeEntry } from "../../src/capture/store";
import type { Env } from "../../src/env";

const base: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "on" };
const llm: Config = { ...base, CONTEXTUAL_EMBEDDING_LLM: "on" };
const off: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "off" };

const text = (tag: string, n: number) =>
  `${tag} notes. ${Array.from({ length: 200 }, (_, i) => `Step ${i} of ${tag} is owned by team ${i * 7} and reviewed weekly.`).join(" ")}`.slice(0, n);

function harness(d1: SqliteD1, generate: (n: number) => string | Error = n => `Covers part ${n} of the rollout plan.`) {
  const index = new Map<string, Record<string, any>>();
  const kv = makeMemoryKV();
  const embeds: string[] = [];
  let gen = 0;
  const sse = (t: string) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: t })}\n\ndata: [DONE]\n`)); c.close(); } });
  const env = {
    DB: d1.db, OAUTH_KV: kv,
    AI: {
      run: vi.fn(async (model: string, input: any) => {
        if (model === DEFAULTS.CONTEXTUAL_EMBEDDING_LLM_MODEL) {
          const r = generate(++gen);
          if (r instanceof Error) throw r;
          return sse(r);
        }
        embeds.push(input.text[0]);
        return { data: [[0.1, 0.2, 0.3]] };
      }),
    },
    VECTORIZE: {
      upsert: vi.fn(async (vs: { id: string; metadata: Record<string, any> }[]) => { for (const v of vs) index.set(v.id, v.metadata); return { count: vs.length }; }),
      deleteByIds: vi.fn(async (ids: string[]) => { for (const id of ids) index.delete(id); }),
    },
  } as unknown as Env;
  return { env, index, kv, embeds, generated: () => gen };
}

async function seed(d1: SqliteD1, h: ReturnType<typeof harness>, id: string, content: string, createdAt: number) {
  d1.seed({ id, content, createdAt });
  await storeEntry(h.env, id, content, [], "api", createdAt, off, { workspaceId: "", actorId: "" });
}
const settle = async (env: Env) => { for (let i = 0; i < 20; i++) if ((await runSchemeBatch(env, base)).done) return; };

describe("generated context tier", () => {
  let d1: SqliteD1;
  beforeEach(() => { d1 = makeSqliteD1(); });

  it("does nothing, and reads nothing, while off", async () => {
    const h = harness(d1);
    await seed(d1, h, "a", text("Alpha", 3000), 1);
    await settle(h.env);
    const get = vi.spyOn(h.kv, "get");
    const r = await runLlmContextBatch(h.env, base);
    expect(r).toMatchObject({ calls: 0, idle: true });
    expect(get).not.toHaveBeenCalled();
    expect(h.generated()).toBe(0);
  });

  it("waits for the deterministic migration to finish", async () => {
    const h = harness(d1);
    await seed(d1, h, "a", text("Alpha", 3000), 1);
    expect(await runLlmContextBatch(h.env, llm)).toMatchObject({ calls: 0, idle: true });
  });

  it("upgrades a whole entry: generated sentence in the embedding text, raw text in metadata", async () => {
    const h = harness(d1);
    await seed(d1, h, "a", text("Alpha", 3000), 1);
    await settle(h.env);
    h.embeds.length = 0;
    const r = await runLlmContextBatch(h.env, llm);
    expect(r).toMatchObject({ upgraded: 1, stalled: false });
    expect(r.calls).toBe(h.embeds.length);
    expect(h.embeds.every(t => /^\[Memory: Covers part \d+ of the rollout plan\.\]\n/.test(t))).toBe(true);
    for (const m of h.index.values()) {
      expect(m.contextSource).toBe("llm");
      expect(String(m.content)).not.toContain("[Memory:");
    }
  });

  it("caps model calls per night and never upgrades half an entry", async () => {
    const h = harness(d1);
    for (let i = 0; i < 4; i++) await seed(d1, h, `e${i}`, text(`Topic${i}`, 3000), i + 1);
    await settle(h.env);
    const first = await runLlmContextBatch(h.env, llm);
    expect(first.calls).toBeLessThanOrEqual(CONTEXT_LLM_CHUNKS_PER_NIGHT);
    expect(first.upgraded).toBeGreaterThan(0);
    expect(first.upgraded).toBeLessThan(4);
    const perEntry = (id: string) => [...h.index.entries()].filter(([k]) => k.startsWith(`${id}-chunk-`)).map(([, m]) => m.contextSource);
    for (let i = 0; i < 4; i++) expect(new Set(perEntry(`e${i}`)).size).toBe(1);
    await runLlmContextBatch(h.env, llm);
    await runLlmContextBatch(h.env, llm);
    for (let i = 0; i < 4; i++) expect(perEntry(`e${i}`).every(s => s === "llm")).toBe(true);
  });

  it("leaves deterministic vectors untouched when generation fails, and steps past the entry after three nights", async () => {
    const h = harness(d1, () => new Error("model unavailable"));
    await seed(d1, h, "a", text("Alpha", 3000), 1);
    await seed(d1, h, "b", text("Beta", 3000), 2);
    await settle(h.env);
    const before = new Map(h.index);
    for (let night = 1; night <= 2; night++) {
      expect(await runLlmContextBatch(h.env, llm)).toMatchObject({ stalled: true, upgraded: 0, skipped: 0 });
      expect(h.index).toEqual(before);
    }
    expect(await runLlmContextBatch(h.env, llm)).toMatchObject({ stalled: true, skipped: 1 });
    const state = JSON.parse((await h.kv.get(CONTEXT_LLM_BACKFILL_KV_KEY))!);
    expect(state.cursorId).toBe("a");
    expect(h.index).toEqual(before);
  });

  it("skips short entries and entries with more than eight chunks", async () => {
    const h = harness(d1);
    await seed(d1, h, "short", "a short note", 1);
    await seed(d1, h, "huge", text("Huge", 20000), 2);
    await settle(h.env);
    const r = await runLlmContextBatch(h.env, llm);
    expect(r).toMatchObject({ calls: 0, upgraded: 0 });
  });
});

describe("cleanGeneratedContext", () => {
  it("accepts one plain sentence and trims quotes and whitespace", () => {
    expect(cleanGeneratedContext('  "Covers the electrician quote for the panel swap."\n')).toBe("Covers the electrician quote for the panel swap.");
  });
  it("rejects empty, markup, preamble, prompt echo and overlong output", () => {
    for (const bad of ["", "**Bold** claim", "Sure, here is a sentence.", "Here's the context", "This chunk of the memory covers x", "x".repeat(200), "a [b] c", "Memory: something"]) {
      expect(cleanGeneratedContext(bad), bad).toBeNull();
    }
  });
});
