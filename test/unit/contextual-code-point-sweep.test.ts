/**
 * Opt-in exhaustive check of the token estimator against the real BGE Small
 * tokenizer: every Unicode code point, alone, inside a word, between two
 * vocabulary words and repeated. About 90 seconds and needs the model cache.
 *
 *   npm run test:eval:local-models   (fetches the model once)
 *   npm run test:token-sweep
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateBgeSmallTokens } from "../../src/capture/contextual";

const modelDir = resolve(__dirname, "../../.eval-cache/models/bge-small-en-v1.5-5c38ec7c405e");
const run = !!process.env.CODE_POINT_SWEEP && existsSync(resolve(modelDir, "tokenizer.json"));

describe.skipIf(!run)("estimator vs the real tokenizer over every code point (CODE_POINT_SWEEP=1)", () => {
  it("never undercounts a character alone, in a word, between words, or repeated", async () => {
    const tf = await import("@huggingface/transformers");
    const tok = await tf.AutoTokenizer.from_pretrained(modelDir, { local_files_only: true });
    const real = (s: string) => (tok(s, { truncation: false }).input_ids.tolist() as number[][])[0].length - 2;
    const est = (s: string) => estimateBgeSmallTokens(s) - 2;
    const under: string[] = [];
    for (let cp = 1; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // a lone surrogate reaches the embedder as U+FFFD, which is deleted
      const ch = String.fromCodePoint(cp);
      for (const [ctx, s] of [["alone", ch], ["in a word", `abc${ch}xyz`], ["between words", `analysis${ch}entrepreneurship`], ["repeated", ch.repeat(5)]] as const) {
        if (real(s) > est(s) && under.length < 20) under.push(`U+${cp.toString(16)} ${ctx}: real ${real(s)}, estimated ${est(s)}`);
      }
    }
    expect(under).toEqual([]);
  }, 900_000);
});
