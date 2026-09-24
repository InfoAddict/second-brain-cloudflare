/**
 * The contextual builder runs on every write of a long note, inside a Worker
 * whose free plan allows 10 ms of CPU per invocation. It must stay linear in
 * the note's size and cheap in absolute terms. Timings are the minimum of
 * several warm runs, which is robust to a busy machine; the absolute budgets
 * carry a wide margin over what the linear implementation measures, and the
 * scaling check catches a return to quadratic behavior on its own.
 */
import { describe, it, expect } from "vitest";
import { buildEmbeddingChunks, estimateBgeSmallTokens, isContextEligible, type ContextEntry } from "../../src/capture/contextual";
import { CONTEXT_MAX_CONTENT_CHARS, CONTEXT_MAX_CONTENT_TOKENS } from "../../src/constants";
import { DEFAULTS, type Config } from "../../src/config";
import { chunkText } from "../../src/text/chunk";

/**
 * CPU time of a fixed reference workload, best of several runs. CPU time inflates on a machine that is busy (shared
 * caches, hyperthreads, throttling), so the budgets below scale with how much slower this workload runs than it did
 * on a quiet one. A regression to quadratic work is 9x at these sizes and still fails.
 */
function referenceMs(): number {
  let best = Infinity;
  for (let r = 0; r < 9; r++) {
    const before = process.cpuUsage();
    let h = 2166136261;
    let s = "";
    for (let i = 0; i < 300_000; i++) {
      h = Math.imul(h ^ (i & 255), 16777619);
      if ((i & 4095) === 0) s = `${s.slice(-64)}${h}`;
    }
    if (h === 42 && s === "never") throw new Error("keep the loop");
    const c = process.cpuUsage(before);
    best = Math.min(best, (c.user + c.system) / 1000);
  }
  return best;
}
/** referenceMs() on a quiet machine. */
const REFERENCE_QUIET_MS = 0.3;

/**
 * A third of the free plan's 10 ms CPU per invocation, scaled for how busy the machine is at the moment of the check
 * (never below the quiet-machine budget, at most 4x). Read fresh each time, because load comes and goes during a run.
 */
const cpuBudget = (): number => 3.3 * Math.min(4, Math.max(1, referenceMs() / REFERENCE_QUIET_MS));

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

const SIZES = [8_000, 16_000, 24_000];
const shapes: [string, (n: number) => string][] = [["prose", prose], ["token-dense", dense], ["no sentence ends", noStops], ["CJK", cjk]];

describe("contextual builder CPU", () => {
  for (const [name, make] of shapes) {
    it(`${name}: stays within budget at 8, 16 and 24 KB (the size limit)`, () => {
      const timings = SIZES.map(n => bestMs(() => buildEmbeddingChunks(entryOf(make(n)), on)));
      // Free-plan CPU is 10 ms per invocation for the whole request, so the builder gets a third of it: at least 3x headroom.
      SIZES.forEach((n, i) => expect(timings[i], `${name} ${n} chars took ${timings[i].toFixed(2)} ms`).toBeLessThan(cpuBudget()));
    });

    it(`${name}: scales linearly (24 KB costs at most 6x 8 KB; linear is 3x, quadratic 9x)`, () => {
      const small = bestMs(() => buildEmbeddingChunks(entryOf(make(8_000)), on));
      const large = bestMs(() => buildEmbeddingChunks(entryOf(make(24_000)), on));
      expect(large / Math.max(small, 0.05)).toBeLessThan(6);
    });
  }

  it("bge-m3 at the size limit stays within budget too", () => {
    expect(bestMs(() => buildEmbeddingChunks(entryOf(prose(24_000)), M3))).toBeLessThan(cpuBudget());
  });

  it("notes past the size limit are chunked plain, so the builder's cost is bounded", () => {
    for (const n of [64_000, 256_000]) {
      expect(buildEmbeddingChunks(entryOf(prose(n)), on).every(c => !c.contextualized)).toBe(true);
      expect(bestMs(() => buildEmbeddingChunks(entryOf(prose(n)), on)), `${n} chars`).toBeLessThan(cpuBudget());
    }
  });

  it("a token-dense note is cut off by its estimated tokens well before its characters: past the token limit it is chunked plain", () => {
    const big = dense(CONTEXT_MAX_CONTENT_TOKENS + 4_000);
    expect(big.length).toBeLessThan(CONTEXT_MAX_CONTENT_CHARS);
    expect(estimateBgeSmallTokens(big)).toBeGreaterThan(CONTEXT_MAX_CONTENT_TOKENS);
    expect(buildEmbeddingChunks(entryOf(big), on).every(c => !c.contextualized)).toBe(true);
  });

  it("the whole write (storeEntry's own JavaScript) of the worst eligible shapes stays within a third of 10 ms", async () => {
    const { storeEntry } = await import("../../src/capture/store");
    const { makeTestEnv } = await import("../helpers/make-env");
    // The largest token-dense note that is still contextualized, and the slowest-to-classify prose at the size limit.
    let n = CONTEXT_MAX_CONTENT_TOKENS;
    while (n > 1000 && !isContextEligible(entryOf(dense(n)))) n -= 250;
    const shapes: [string, string][] = [["token-dense at its limit", dense(n)], ["common words at 24 KB", `Notes\n${"the quick brown fox jumps over the lazy dog and then ".repeat(480)}`.slice(0, 24_000)], ["prose at 24 KB", prose(24_000)]];
    for (const [name, content] of shapes) {
      expect(isContextEligible(entryOf(content)), `${name} is contextualized`).toBe(true);
      const env = makeTestEnv();
      await storeEntry(env, "e", content, ["a"], "x", 1, on);
      let best = Infinity;
      for (let i = 0; i < 15; i++) {
        const before = process.cpuUsage();
        await storeEntry(env, "e", content, ["a"], "x", 1, on);
        const c = process.cpuUsage(before);
        best = Math.min(best, (c.user + c.system) / 1000);
      }
      expect(best, `${name} (${content.length} chars) took ${best.toFixed(2)} ms of CPU`).toBeLessThan(cpuBudget());
    }
  });

  it("the legacy chunker is linear even with no period or newline to snap to", () => {
    const small = bestMs(() => chunkText("x".repeat(64_000)));
    const large = bestMs(() => chunkText("x".repeat(256_000)));
    expect(large / Math.max(small, 0.05)).toBeLessThan(8);
  });

  it("the token estimator handles 24 KB well within budget", () => {
    expect(bestMs(() => estimateBgeSmallTokens(prose(24_000)))).toBeLessThan(cpuBudget());
  });
});
