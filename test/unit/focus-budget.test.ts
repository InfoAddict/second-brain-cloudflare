import { describe, it, expect, beforeEach, vi } from "vitest";
import { focusModeAllowed, resetFocusBudgetCache } from "../../src/capture/focus-budget";
import { buildEmbeddingChunks } from "../../src/capture/contextual";
import { storeEntry } from "../../src/capture/store";
import { DEFAULTS, type Config } from "../../src/config";
import { chunkText } from "../../src/text/chunk";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

const on: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "on" };
const envWith = (info: unknown | Error) => {
  const env = makeTestEnv();
  (env.VECTORIZE as { describe: unknown }).describe = vi.fn(async () => { if (info instanceof Error) throw info; return info; });
  return env as Env;
};
// Plain prose, like the golden set's long notes: digits would make the token estimate (which runs high on them) shrink the chunks.
const WORDS = ["neighbor", "schedule", "rota", "cable", "apricots", "draft", "hallway", "printer", "deadline", "napkin", "paperwork", "leaflet"];
const NAMES = ["Karin", "Petra", "Yusuf", "Odile", "Idris", "Lucia", "Saskia", "Ruben"];
const note = (tag: string, n = 2733) =>
  `${tag} programme notes. ${Array.from({ length: 200 }, (_, i) => `Before we broke for tea, ${NAMES[i % 8]} brought up the ${WORDS[i % 12]} again, and ${NAMES[(i * 3) % 8]} mentioned the ${WORDS[(i * 5) % 12]} for the ${i % 3 ? "third" : "second"} time that day.`).join(" ")}`.slice(0, n);
const entryOf = (id: string, content: string) => ({ id, content, tags: [] as string[], source: "api", createdAt: 1 });

beforeEach(() => resetFocusBudgetCache());

describe("focusModeAllowed", () => {
  it("allows focus chunks while the index holds fewer stored dimensions than the budget", async () => {
    expect(await focusModeAllowed(envWith({ vectorCount: 1000, dimensions: 384 }), on)).toBe(true);
  });
  it("refuses once the budget is reached, reading either describe shape", async () => {
    expect(await focusModeAllowed(envWith({ vectorCount: 7900, dimensions: 384 }), on)).toBe(false);
    resetFocusBudgetCache();
    expect(await focusModeAllowed(envWith({ vectorsCount: 7900, config: { dimensions: 384 } }), on)).toBe(false);
  });
  it("a budget of 0 removes the limit and never reads the index", async () => {
    const env = envWith({ vectorCount: 9e6, dimensions: 384 });
    expect(await focusModeAllowed(env, { ...on, CONTEXTUAL_FOCUS_DIMENSION_BUDGET: 0 })).toBe(true);
    expect(env.VECTORIZE.describe).not.toHaveBeenCalled();
  });
  it("fails open when the index size cannot be read", async () => {
    expect(await focusModeAllowed(envWith(new Error("down")), on)).toBe(true);
    resetFocusBudgetCache();
    expect(await focusModeAllowed(envWith({}), on)).toBe(true);
  });
  it("remembers the size for a few minutes instead of reading it on every write", async () => {
    const env = envWith({ vectorCount: 10, dimensions: 384 });
    await focusModeAllowed(env, on);
    await focusModeAllowed(env, on);
    expect(env.VECTORIZE.describe).toHaveBeenCalledTimes(1);
  });
});

describe("storeEntry under the focus budget", () => {
  it("cuts a long note into focus chunks while there is room, and at the tail size once there is not", async () => {
    const roomy = envWith({ vectorCount: 100, dimensions: 384 });
    await storeEntry(roomy, "a", note("A"), [], "api", 1, on);
    const focusN = (roomy.VECTORIZE.upsert as any).mock.calls[0][0].length as number;
    resetFocusBudgetCache();
    const full = envWith({ vectorCount: 9000, dimensions: 384 });
    await storeEntry(full, "a", note("A"), [], "api", 1, on);
    const tailN = (full.VECTORIZE.upsert as any).mock.calls[0][0].length as number;
    expect(focusN).toBeGreaterThan(tailN);
    expect(tailN).toBeLessThanOrEqual(chunkText(note("A")).length + 3);
  });

  it("does not read the index for a note that gets no focus chunks", async () => {
    const env = envWith({ vectorCount: 100, dimensions: 384 });
    await storeEntry(env, "a", "a short note", [], "api", 1, on);
    expect(env.VECTORIZE.describe).not.toHaveBeenCalled();
  });
});

describe("capacity under the focus budget (free plan, bge-small, 384 dimensions)", () => {
  /** Adds notes until the index holds `limit` vectors, following the same rule storeEntry does; returns memories stored. */
  const fill = (share: number, contextual: boolean, limit = 13_020, budgetDims: number = DEFAULTS.CONTEXTUAL_FOCUS_DIMENSION_BUDGET) => {
    let vectors = 0, memories = 0, longSeen = 0;
    const longNote = note("Long");
    for (;;) {
      const isLong = longSeen < Math.floor((memories + 1) * share);
      const focus = vectors * 384 < budgetDims;
      const n = !isLong ? 1 : contextual
        ? buildEmbeddingChunks(entryOf("x", longNote), on, undefined, focus).length
        : chunkText(longNote).length;
      if (vectors + n > limit) return memories;
      vectors += n; memories++; if (isLong) longSeen++;
    }
  };

  for (const [share, maxLoss] of [[0.035, 0.08], [0.2, 0.2], [0.4, 0.25]] as const) {
    it(`a ${share * 100}% long-note brain loses at most ${maxLoss * 100}% of its capacity to focus chunks`, () => {
      const legacy = fill(share, false);
      const now = fill(share, true);
      expect(1 - now / legacy, `legacy ${legacy} memories, now ${now}`).toBeLessThanOrEqual(maxLoss);
    });
  }

  it.runIf(process.env.CAPACITY_REPORT)("prints the capacity table", async () => {
    const { writeFileSync } = await import("node:fs");
    const out = [`per ${note("L").length}-char note: legacy ${chunkText(note("L")).length}, focus ${buildEmbeddingChunks(entryOf("x", note("L")), on, undefined, true).length}, tail-size ${buildEmbeddingChunks(entryOf("x", note("L")), on, undefined, false).length}`];
    for (const share of [0.035, 0.05, 0.1, 0.2, 0.4]) {
      const legacy = fill(share, false), bounded = fill(share, true), unb = fill(share, true, 13_020, Infinity);
      out.push(`share ${share * 100}%: memories at 13,020 vectors: legacy ${legacy}, per-note cap only ${unb} (loss ${(100 * (1 - unb / legacy)).toFixed(1)}%), with budget ${bounded} (loss ${(100 * (1 - bounded / legacy)).toFixed(1)}%)`);
    }
    writeFileSync(process.env.CAPACITY_REPORT!, out.join("\n"));
  });

  it("without the budget the loss at a 20% share is what the per-note cap alone gives, well over 25%", () => {
    const legacy = fill(0.2, false);
    const unbounded = fill(0.2, true, 13_020, Infinity);
    expect(1 - unbounded / legacy).toBeGreaterThan(0.25);
  });
});
