/**
 * Long notes are several vectors sharing a parentId. Write-path neighbor
 * queries (duplicate check, graph edges) want distinct memories, and a note of
 * more than a thousand chunks must reach Vectorize in calls it accepts.
 */
import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV } from "../helpers/make-env";
import { ExactVectorize } from "../eval/vectorize-emulator";
import { checkDuplicateAndContradiction } from "../../src/capture/duplicate";
import { deleteStaleVectors, storeEntry } from "../../src/capture/store";
import { neighborsFromVectorQuery } from "../../src/graph/traverse";
import { nearestParents } from "../../src/vectorize/parents";
import { DEFAULTS } from "../../src/config";
import { VECTORIZE_UPSERT_BATCH, WRITE_PATH_TOPK } from "../../src/constants";
import { deleteVectorIds } from "../../src/vectorize/batch";
import type { Env } from "../../src/env";

const DIMS = 256;

/** A hashed bag-of-words embedding: near-identical text scores high, a start/middle/end sample of it scores lower. */
function bow(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}

const WORDS = ["neighbor", "schedule", "rota", "cable", "apricots", "draft", "hallway", "printer", "deadline", "napkin", "paperwork", "leaflet"];
const NAMES = ["Karin", "Petra", "Yusuf", "Odile", "Idris", "Lucia", "Saskia", "Ruben"];
const longNote = (tag: string) =>
  `${tag} programme notes. ${Array.from({ length: 200 }, (_, i) => `${NAMES[(i * 7 + tag.length) % 8]} brought up the ${WORDS[(i * 5 + tag.length) % 12]} again while ${NAMES[(i * 3) % 8]} mentioned the ${WORDS[(i * 11) % 12]} and the ${tag} plan ${["first", "second", "third"][i % 3]} time.`).join(" ")}`.slice(0, 2733);

function makeEnv() {
  const d1 = makeSqliteD1();
  const vectorize = new ExactVectorize({ dimensions: DIMS });
  const embeds: string[] = [];
  const env = {
    DB: d1.db, OAUTH_KV: makeMemoryKV(), VECTORIZE: vectorize as unknown as VectorizeIndex,
    AI: { run: vi.fn(async (_m: string, input: { text: string[] }) => { embeds.push(input.text[0]); return { data: [bow(input.text[0])] }; }) },
    VECTORIZE_GRACE_MS: "0",
  } as unknown as Env;
  return { env, d1, vectorize, embeds };
}

describe("nearestParents", () => {
  it("keeps each parent's best hit, best first, at most the limit", () => {
    const hits = [
      { id: "a-chunk-0", score: 0.9, metadata: { parentId: "a" } }, { id: "a-chunk-1", score: 0.95, metadata: { parentId: "a" } },
      { id: "a-chunk-2", score: 0.8, metadata: { parentId: "a" } }, { id: "b", score: 0.7 }, { id: "c", score: 0.6 },
    ];
    expect(nearestParents(hits, 2).map(m => [m.id, m.score])).toEqual([["a-chunk-1", 0.95], ["b", 0.7]]);
    expect(nearestParents([], 5)).toEqual([]);
  });
});

describe("neighbor queries over long notes", () => {
  it("asks a wider window and still returns five distinct notes when one long note fills the nearest slots", async () => {
    const query = vi.fn(async () => ({
      matches: [
        ...Array.from({ length: 7 }, (_, i) => ({ id: `long-chunk-${i}`, score: 0.99 - i * 0.01, metadata: { parentId: "long" } })),
        ...["n1", "n2", "n3", "n4", "n5", "n6"].map((id, i) => ({ id, score: 0.8 - i * 0.05 })),
      ],
    }));
    const env = { VECTORIZE: { query } } as unknown as Env;
    const neighbors = await neighborsFromVectorQuery([0.1], env);
    expect(query).toHaveBeenCalledWith([0.1], expect.objectContaining({ topK: WRITE_PATH_TOPK }));
    expect(neighbors.map(n => n.id)).toEqual(["long", "n1", "n2", "n3", "n4"]);
    expect(neighbors[0].score).toBe(0.99);
  });
});

describe("duplicate check on long notes", () => {
  it("collapses one long note's chunks so neighbors are distinct notes", async () => {
    const { env, d1 } = makeEnv();
    for (const [i, t] of ["Fuse box", "Kitchen", "Trip plan", "Retro notes", "Garden", "Tax filing", "Boat repair"].entries()) {
      d1.seed({ id: `n${i}`, content: longNote(t), createdAt: i + 1 });
      await storeEntry(env, `n${i}`, longNote(t), [], "api", i + 1);
    }
    const r = await checkDuplicateAndContradiction(longNote("Fuse box"), env, DEFAULTS);
    expect(r.neighbors.length).toBeGreaterThan(3);
    expect(new Set(r.neighbors.map(n => n.id)).size).toBe(r.neighbors.length);
    expect(r.neighbors.length).toBeLessThanOrEqual(5);
  });
});

describe("Vectorize call sizes", () => {
  it("upserts a note of more than a thousand chunks in calls of at most VECTORIZE_UPSERT_BATCH", async () => {
    const { env, d1, vectorize } = makeEnv();
    const sizes: number[] = [];
    const upsert = vectorize.upsert.bind(vectorize);
    vectorize.upsert = (async (vs: unknown[]) => { sizes.push(vs.length); return upsert(vs as never); }) as never;
    const content = "x".repeat(1_700_000);
    d1.seed({ id: "huge", content, createdAt: 1 });
    const stored = await storeEntry(env, "huge", content, [], "api", 1);
    expect(stored.vectorIds.length).toBeGreaterThan(VECTORIZE_UPSERT_BATCH);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(VECTORIZE_UPSERT_BATCH);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(stored.vectorIds.length);
  }, 120_000);

  it("deletes vectors in calls of at most VECTORIZE_UPSERT_BATCH, and never deletes an id that is kept", async () => {
    const calls: string[][] = [];
    const env = { VECTORIZE: { deleteByIds: vi.fn(async (ids: string[]) => { calls.push(ids); }) } } as unknown as Env;
    const ids = Array.from({ length: 2_500 }, (_, i) => `v${i}`);
    await deleteVectorIds(env, ids);
    expect(calls.map(c => c.length)).toEqual([1000, 1000, 500]);
    expect(calls.flat()).toEqual(ids);

    calls.length = 0;
    await deleteStaleVectors(env, ids, ids.slice(0, 1_200));
    expect(calls.flat()).toEqual(ids.slice(1_200));
    expect(Math.max(...calls.map(c => c.length))).toBeLessThanOrEqual(VECTORIZE_UPSERT_BATCH);
  });
});
