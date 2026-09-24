/**
 * BERT deletes zero-width, format, private-use, control and combining
 * characters before it splits words, so two words with one between them are a
 * single word to the tokenizer: "analysis­entrepreneurship" is 9 tokens, not
 * the 2 that two vocabulary words would be. The estimator must glue across them.
 * Real counts for 300 random vocabulary-word pairs joined by each deleted
 * character are in a committed fixture, so the check runs without the model.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMON_WORD_LIST } from "../../src/capture/common-words";
import { estimateBgeSmallTokens } from "../../src/capture/contextual";

const DELETED: [string, string][] = [
  ["soft hyphen", "­"], ["zero-width space", "​"], ["zero-width non-joiner", "‌"], ["zero-width joiner", "‍"],
  ["variation selector 16", "️"], ["combining acute", "́"], ["replacement character", "�"], ["control (SOH)", "\u0001"],
  ["private use", ""], ["byte order mark", "﻿"],
];

const words = COMMON_WORD_LIST.split(/\s+/).filter(Boolean);
let seed = 424242;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const PAIRS: [string, string][] = Array.from({ length: 300 }, () => [words[Math.floor(rnd() * words.length)], words[Math.floor(rnd() * words.length)]]);
const cases = DELETED.flatMap(([name, d]) => PAIRS.map(([a, b]) => ({ name, text: `${a}${d}${b}` })));

const fixturePath = resolve(__dirname, "fixtures/deleted-char-pair-counts.json");
const modelDir = resolve(__dirname, "../../.eval-cache/models/bge-small-en-v1.5-5c38ec7c405e");
const haveModel = existsSync(resolve(modelDir, "tokenizer.json"));
const load = async () => (await import("@huggingface/transformers")).AutoTokenizer.from_pretrained(modelDir, { local_files_only: true });
const real = (tok: Awaited<ReturnType<typeof load>>, s: string) => (tok(s, { truncation: false }).input_ids.tolist() as number[][])[0].length - 2;

describe("the estimator glues words across characters BERT deletes", () => {
  it("counts the reviewer's example at least as high as the tokenizer does", () => {
    expect(estimateBgeSmallTokens("analysis­entrepreneurship") - 2).toBeGreaterThanOrEqual(9);
    expect(estimateBgeSmallTokens("analysis​entrepreneurship") - 2).toBeGreaterThanOrEqual(9);
  });

  it("still discounts a vocabulary word split by a deleted character, since BERT sees the whole word", () => {
    expect(estimateBgeSmallTokens("ana­lysis") - 2).toBe(1);
  });

  it("random vocabulary-word pairs joined by each deleted character never undercount (committed fixture of real counts)", () => {
    const recorded = JSON.parse(readFileSync(fixturePath, "utf8")) as number[];
    expect(recorded.length).toBe(cases.length);
    const under = cases.map((c, i) => ({ ...c, real: recorded[i], est: estimateBgeSmallTokens(c.text) - 2 })).filter(c => c.est < c.real);
    expect(under.slice(0, 5).map(c => `${c.name}: ${JSON.stringify(c.text)} est ${c.est} real ${c.real}`)).toEqual([]);
  });

  it("control characters and zero-width characters neither cost a token nor end a run", () => {
    expect(estimateBgeSmallTokens("a\u0001b") - 2).toBe(estimateBgeSmallTokens("ab") - 2);
    expect(estimateBgeSmallTokens("​‍️")).toBe(2);
    expect(estimateBgeSmallTokens("é") - 2).toBe(1);
  });

  it("symbols and spacing marks are part of a word to BERT, so they glue too", () => {
    // "analysis©entrepreneurship" is one word to BERT (a copyright sign is not punctuation): it must not be discounted as two words.
    expect(estimateBgeSmallTokens("analysis©entrepreneurship") - 2).toBeGreaterThan(3);
    expect(estimateBgeSmallTokens("analysisःentrepreneurship") - 2).toBeGreaterThan(3);
  });

  it.skipIf(!haveModel)("the fixture matches the pinned tokenizer (skipped: .eval-cache/models is not present; run npm run test:eval:local-models to fetch it)", async () => {
    const tok = await load();
    const recorded = JSON.parse(readFileSync(fixturePath, "utf8")) as number[];
    cases.forEach((c, i) => { if (recorded[i] !== real(tok, c.text)) throw new Error(`${c.name} ${JSON.stringify(c.text)}: recorded ${recorded[i]}, tokenizer ${real(tok, c.text)}`); });
  });

  it.skipIf(!haveModel || !process.env.UPDATE_TOKEN_FIXTURE)("rewrites the fixture from the pinned tokenizer (UPDATE_TOKEN_FIXTURE=1)", async () => {
    const tok = await load();
    writeFileSync(fixturePath, `${JSON.stringify(cases.map(c => real(tok, c.text)))}\n`);
  });
});
