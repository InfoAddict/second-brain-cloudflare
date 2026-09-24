/**
 * Long notes are several vectors sharing a parentId. Write-path neighbor
 * queries (duplicate check, graph edges) want distinct memories, and the
 * duplicate check must still recognise a re-captured long note now that it is
 * stored as small prefixed chunks.
 */
import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV } from "../helpers/make-env";
import { ExactVectorize } from "../eval/vectorize-emulator";
import { checkDuplicateAndContradiction } from "../../src/capture/duplicate";
import { storeEntry } from "../../src/capture/store";
import { neighborsFromVectorQuery } from "../../src/graph/traverse";
import { nearestParents } from "../../src/vectorize/parents";
import { resetFocusBudgetCache } from "../../src/capture/focus-budget";
import { DEFAULTS, type Config } from "../../src/config";
import { WRITE_PATH_TOPK } from "../../src/constants";
import type { Env } from "../../src/env";

const on: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "on" };
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

describe("duplicate check on a re-captured long note", () => {
  it("recognises the same note as a duplicate against its stored focus chunks", async () => {
    resetFocusBudgetCache();
    const { env, d1 } = makeEnv();
    const content = longNote("Fuse box");
    d1.seed({ id: "orig", content, createdAt: 1 });
    await storeEntry(env, "orig", content, [], "api", 1, on);
    resetFocusBudgetCache();
    const r = await checkDuplicateAndContradiction(content, env, on);
    expect(r.duplicate.status).not.toBe("unique");
    expect((r.duplicate as { matchId: string }).matchId).toBe("orig");
    expect((r.duplicate as { score: number }).score).toBeGreaterThanOrEqual(DEFAULTS.DUPLICATE_BLOCK_THRESHOLD);
  });

  it("embeds the comparison exactly as capture would store the note's first chunk", async () => {
    resetFocusBudgetCache();
    const { env, d1, vectorize, embeds } = makeEnv();
    const content = longNote("Fuse box");
    d1.seed({ id: "orig", content, createdAt: 1 });
    await storeEntry(env, "orig", content, [], "api", 1, on);
    const stored = (await vectorize.getByIds(["orig-chunk-0"]))[0].metadata as { content: string };
    embeds.length = 0;
    resetFocusBudgetCache();
    await checkDuplicateAndContradiction(content, env, on);
    const asStored = embeds.find(t => t.startsWith("[Memory: "));
    expect(asStored, "a prefixed comparison embed").toBeDefined();
    expect(asStored!.endsWith(`\n${stored.content}`)).toBe(true);
    // and the whole-note sample is still embedded, for notes stored before contextual embeddings
    expect(embeds.some(t => t.includes("\n...\n"))).toBe(true);
  });

  it("does not call an unrelated long note a duplicate", async () => {
    resetFocusBudgetCache();
    const { env, d1 } = makeEnv();
    d1.seed({ id: "orig", content: longNote("Fuse box"), createdAt: 1 });
    await storeEntry(env, "orig", longNote("Fuse box"), [], "api", 1, on);
    resetFocusBudgetCache();
    const other = "Trip planning. " + Array.from({ length: 150 }, (_, i) => `On day ${i} we rented a car and drove past the harbour toward the northern glacier, stopping for soup.`).join(" ");
    expect((await checkDuplicateAndContradiction(other, env, on)).duplicate.status).toBe("unique");
  });

  it("compares a long note two ways (sample and first stored chunk) but a short note one way", async () => {
    resetFocusBudgetCache();
    const { env, embeds } = makeEnv();
    await checkDuplicateAndContradiction(longNote("Fuse box"), env, on);
    expect(embeds).toHaveLength(2);
    embeds.length = 0;
    await checkDuplicateAndContradiction("a short note", env, on);
    expect(embeds).toHaveLength(1);
  });

  it("with contextual embeddings off, compares exactly as before", async () => {
    const { env, embeds } = makeEnv();
    await checkDuplicateAndContradiction(longNote("Fuse box"), env, { ...on, CONTEXTUAL_EMBEDDINGS: "off" });
    expect(embeds).toHaveLength(1);
  });

  it("still finds a note stored before contextual embeddings (whole 1,600-character chunks) through the sample", async () => {
    resetFocusBudgetCache();
    const { env, d1 } = makeEnv();
    const content = longNote("Fuse box");
    d1.seed({ id: "old", content, createdAt: 1 });
    await storeEntry(env, "old", content, [], "api", 1, { ...on, CONTEXTUAL_EMBEDDINGS: "off" });
    const r = await checkDuplicateAndContradiction(content, env, on);
    expect(r.duplicate.status).not.toBe("unique");
  });

  it("collapses one long note's chunks so neighbors are distinct notes", async () => {
    resetFocusBudgetCache();
    const { env, d1 } = makeEnv();
    for (const [i, t] of ["Fuse box", "Kitchen", "Trip plan", "Retro notes", "Garden", "Tax filing", "Boat repair"].entries()) {
      d1.seed({ id: `n${i}`, content: longNote(t), createdAt: i + 1 });
      await storeEntry(env, `n${i}`, longNote(t), [], "api", i + 1, on);
    }
    resetFocusBudgetCache();
    const r = await checkDuplicateAndContradiction(longNote("Fuse box"), env, on);
    expect(r.neighbors.length).toBeGreaterThan(3);
    expect(new Set(r.neighbors.map(n => n.id)).size).toBe(r.neighbors.length);
    expect(r.neighbors.length).toBeLessThanOrEqual(5);
  });
});
