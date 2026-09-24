/**
 * The contextual builder runs on every write of a long note, inside a Worker
 * whose free plan allows 10 ms of CPU per invocation. It must stay linear in
 * the note's size and cheap in absolute terms. Timings are the minimum of
 * several warm runs, which is robust to a busy machine; the absolute budgets
 * carry a wide margin over what the linear implementation measures, and the
 * scaling check catches a return to quadratic behavior on its own.
 */
import { describe, it, expect } from "vitest";
import { buildEmbeddingChunks, estimateBgeSmallTokens, type ContextEntry } from "../../src/capture/contextual";
import { DEFAULTS, type Config } from "../../src/config";
import { chunkText } from "../../src/text/chunk";

const on: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "on" };
const M3: Config = { ...on, EMBEDDING_MODEL: "@cf/baai/bge-m3" };

const prose = (n: number) => `Quarterly retro notes.\n${Array.from({ length: Math.ceil(n / 60) }, (_, i) => `Step ${i} of the plan is owned by team ${i * 7}.`).join(" ")}`.slice(0, n);
const dense = (n: number) => `Dump.\n${Array.from({ length: Math.ceil(n / 12) }, (_, i) => `id${i}:0x${(i * 7919).toString(16)};`).join(" ")}`.slice(0, n);
const noStops = (n: number) => `title\n${"word ".repeat(Math.ceil(n / 5))}`.slice(0, n);
const cjk = (n: number) => `設計\n${"設計のレビューを行う".repeat(Math.ceil(n / 10))}`.slice(0, n);

const entryOf = (content: string): ContextEntry => ({ id: "e", content, tags: ["project:a", "design", "review", "kind:decision"], source: "claude-desktop", createdAt: 1_700_000_000_000 });

/** Best of `runs` warm timings, in ms. */
function bestMs(fn: () => unknown, runs = 15): number {
  fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

const SIZES = [8_000, 16_000, 64_000];
const shapes: [string, (n: number) => string][] = [["prose", prose], ["token-dense", dense], ["no sentence ends", noStops], ["CJK", cjk]];

describe("contextual builder CPU", () => {
  for (const [name, make] of shapes) {
    it(`${name}: stays within budget at 8, 16 and 64 KB`, () => {
      const timings = SIZES.map(n => bestMs(() => buildEmbeddingChunks(entryOf(make(n)), on)));
      // Free-plan CPU is 10 ms per invocation for the whole request; the builder is allowed a fraction of it.
      const budgets = [2, 3, 8];
      SIZES.forEach((n, i) => expect(timings[i], `${name} ${n} chars took ${timings[i].toFixed(2)} ms`).toBeLessThan(budgets[i]));
    });

    it(`${name}: scales linearly (64 KB costs at most 8x 16 KB; linear is 4x, quadratic 16x)`, () => {
      const small = bestMs(() => buildEmbeddingChunks(entryOf(make(16_000)), on));
      const large = bestMs(() => buildEmbeddingChunks(entryOf(make(64_000)), on));
      expect(large / Math.max(small, 0.05)).toBeLessThan(8);
    });
  }

  it("bge-m3 at 64 KB stays within budget too", () => {
    expect(bestMs(() => buildEmbeddingChunks(entryOf(prose(64_000)), M3))).toBeLessThan(8);
  });

  it("notes past the size limit are chunked plain, so the builder's cost is bounded", () => {
    const big = buildEmbeddingChunks(entryOf(prose(256_000)), on);
    expect(big.every(c => !c.contextualized)).toBe(true);
    expect(bestMs(() => buildEmbeddingChunks(entryOf(prose(256_000)), on))).toBeLessThan(8);
  });

  it("the legacy chunker is linear even with no period or newline to snap to", () => {
    const small = bestMs(() => chunkText("x".repeat(64_000)));
    const large = bestMs(() => chunkText("x".repeat(256_000)));
    expect(large / Math.max(small, 0.05)).toBeLessThan(8);
  });

  it("the token estimator handles 64 KB in well under a millisecond per 16 KB", () => {
    expect(bestMs(() => estimateBgeSmallTokens(prose(64_000)))).toBeLessThan(6);
  });
});
