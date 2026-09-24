/**
 * No chunk sent to bge-small may exceed its 512-token window, or the embedder
 * silently drops its tail. The estimator is an upper bound by construction; this
 * proves it on what actually ships: every chunk (prefix included) built from
 * adversarial notes is checked against the real BGE Small tokenizer's count.
 *
 * The counts live in a committed fixture keyed by the chunk text's hash, so the
 * check runs without the model cache. If chunking changes, the fixture must be
 * regenerated with the model present: UPDATE_TOKEN_FIXTURE=1 npx vitest run
 * test/unit/contextual-token-guard.test.ts (after npm run test:eval:local-models
 * has fetched the model).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEmbeddingChunks, estimateBgeSmallTokens } from "../../src/capture/contextual";
import { DEFAULTS, type Config } from "../../src/config";
import { BGE_SMALL_MAX_INPUT_TOKENS, CONTEXT_SMALL_TARGET_TOKENS } from "../../src/constants";

const on: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "on" };

let seed = 20260924;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const letters = "abcdefghijklmnopqrstuvwxyz";
const randWord = (min: number, max: number) => Array.from({ length: min + Math.floor(rnd() * (max - min + 1)) }, () => pick([...letters])).join("");
const syll = ["ka", "mo", "ti", "ra", "shu", "ven", "lor", "pex", "dul", "quo", "zin", "bre"];
const fill = (n: number, unit: () => string, sep = " ") => { let s = ""; while (s.length < n) s += unit() + sep; return s.slice(0, n); };
const withTitle = (title: string, body: string) => `${title}\n${body}`;

/** Notes shaped to defeat a token estimate: short random words, random letters, syllables, code, ids, CJK, punctuation, accents. */
const NOTES: Record<string, string> = {
  randomShortWords: withTitle("Notes", fill(6000, () => randWord(2, 4))),
  randomThreeLetterWords: withTitle("Notes", fill(6000, () => randWord(3, 3))),
  randomShortWordsLong: withTitle("Notes", fill(14000, () => randWord(2, 5))),
  randomFiveToEight: withTitle("Notes", fill(5000, () => randWord(5, 8))),
  syllableSoup: withTitle("Notes", fill(6000, () => pick(syll) + pick(syll))),
  consonantClusters: withTitle("Notes", fill(6000, () => Array.from({ length: 4 }, () => pick([..."bcdfghjklmnpqrstvwxz"])).join(""))),
  prose: withTitle("Retro notes.", fill(9000, () => `${pick(["the", "we", "Karin", "rota", "cable"])} ${pick(["brought", "mentioned", "moved", "kept"])} ${pick(["the", "a", "another"])} ${pick(["schedule", "printer", "napkin", "leaflet"])}.`)),
  camelCase: withTitle("Code", fill(6000, () => `${pick(["get", "set", "load", "parse"])}${pick(["User", "Account", "Balance", "Handler"])}${pick(["ById", "Async", "Cache", "Map"])}`)),
  codeLike: withTitle("Code", fill(6000, () => `${randWord(2, 6)}(${randWord(1, 4)}[${randWord(1, 3)}]);`)),
  hexIds: withTitle("Dump", fill(6000, () => `id${Math.floor(rnd() * 1e6)}:0x${Math.floor(rnd() * 2 ** 32).toString(16)};`)),
  uuids: withTitle("Dump", fill(6000, () => `${randWord(8, 8)}-${randWord(4, 4)}-4${randWord(3, 3)}`.replace(/[a-z]/g, c => "0123456789abcdef"[c.charCodeAt(0) % 16]))),
  base64: withTitle("Blob", fill(6000, () => Array.from({ length: 24 }, () => pick([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"])).join("") + "==")),
  urls: withTitle("Links", fill(6000, () => `https://${randWord(3, 8)}.example.com/${randWord(2, 6)}/${randWord(2, 6)}?q=${randWord(2, 5)}&x=${Math.floor(rnd() * 999)}`)),
  cjk: withTitle("設計", fill(5000, () => "設計のレビューを行う。", "")),
  punctuationHeavy: withTitle("Symbols", fill(6000, () => `${pick([..."!?;:,.-_()[]{}<>"])}${randWord(1, 2)}${pick([..."!?;:,.-_()[]{}<>"])}`)),
  accents: withTitle("Notes", fill(6000, () => pick(["naïve", "café", "résumé", "Zoë", "jalapeño", "über", "façade"]))),
  digitsAndWords: withTitle("Log", fill(6000, () => `${randWord(2, 5)}${Math.floor(rnd() * 99)} ${Math.floor(rnd() * 1e5)}`)),
  emoji: withTitle("Fun", fill(5000, () => `${pick(["😀", "🚀", "🎉", "🔥"])}${randWord(1, 3)}`)),
  mixedScripts: withTitle("Mixed", fill(6000, () => `${randWord(2, 4)}${pick(["設", "計", "한", "글", "я", "ж"])}${randWord(1, 3)}`)),
};

interface Shipped { name: string; mode: string; text: string }
function shippedChunks(): Shipped[] {
  const out: Shipped[] = [];
  for (const [name, content] of Object.entries(NOTES)) {
    for (const focus of [true, false]) {
      const chunks = buildEmbeddingChunks({ id: "n", content, tags: ["project:alpha", "design", "review"], source: "claude-desktop", createdAt: 1_700_000_000_000 }, on, undefined, focus);
      chunks.forEach((c, i) => out.push({ name, mode: `${focus ? "focus" : "tail"}#${i}${c.contextualized ? "" : " (plain)"}`, text: c.embeddingText }));
    }
  }
  return out;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 20);
const fixturePath = resolve(__dirname, "fixtures/shipped-chunk-token-counts.json");
const modelDir = resolve(__dirname, "../../.eval-cache/models/bge-small-en-v1.5-5c38ec7c405e");
const haveModel = existsSync(resolve(modelDir, "tokenizer.json"));
const loadTokenizer = async () => (await import("@huggingface/transformers")).AutoTokenizer.from_pretrained(modelDir, { local_files_only: true });
const realCount = (tok: Awaited<ReturnType<typeof loadTokenizer>>, s: string) => (tok(s, { truncation: false }).input_ids.tolist() as number[][])[0].length;

describe("shipped chunks never exceed the BGE Small window", () => {
  const chunks = shippedChunks();

  it("builds a real spread of chunks from every adversarial shape, all contextualized", () => {
    expect(chunks.length).toBeGreaterThan(300);
    for (const name of Object.keys(NOTES)) {
      const mine = chunks.filter(c => c.name === name);
      expect(mine.length, name).toBeGreaterThan(1);
      expect(mine.filter(c => c.mode.endsWith("(plain)")), `${name} fell back to plain chunks`).toEqual([]);
    }
  });

  it("holds every chunk's own token bound within the target, the margin under the window", () => {
    for (const c of chunks) expect(estimateBgeSmallTokens(c.text), `${c.name} ${c.mode}`).toBeLessThanOrEqual(CONTEXT_SMALL_TARGET_TOKENS);
  });

  // Runs everywhere: the evidence is the committed fixture of real tokenizer counts.
  it("every shipped chunk is at most 512 real tokens, and the estimate never undercounts it (committed fixture)", () => {
    const recorded = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, number>;
    const missing = chunks.filter(c => recorded[hash(c.text)] === undefined);
    expect(missing.map(c => `${c.name} ${c.mode}`).slice(0, 5), `${missing.length} shipped chunks are not in the fixture: chunking changed; regenerate it with UPDATE_TOKEN_FIXTURE=1 and the model cache`).toEqual([]);
    for (const c of chunks) {
      const real = recorded[hash(c.text)];
      expect(real, `${c.name} ${c.mode}`).toBeLessThanOrEqual(BGE_SMALL_MAX_INPUT_TOKENS);
      expect(estimateBgeSmallTokens(c.text), `${c.name} ${c.mode} real ${real}`).toBeGreaterThanOrEqual(real);
    }
  });

  it.skipIf(!haveModel)("the fixture matches the pinned tokenizer (skipped: .eval-cache/models is not present; run npm run test:eval:local-models to fetch it)", async () => {
    const tok = await loadTokenizer();
    const recorded = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, number>;
    for (const c of chunks) {
      const real = realCount(tok, c.text);
      expect(real, `${c.name} ${c.mode}`).toBeLessThanOrEqual(BGE_SMALL_MAX_INPUT_TOKENS);
      expect(recorded[hash(c.text)], `${c.name} ${c.mode}`).toBe(real);
    }
  });

  it.skipIf(!haveModel)("every listed vocabulary word is exactly one real token, and the list has no duplicates or non-letters (skipped: model cache not present)", async () => {
    const { COMMON_WORD_LIST } = await import("../../src/capture/common-words");
    const words = COMMON_WORD_LIST.split(/\s+/).filter(Boolean);
    const tok = await loadTokenizer();
    const bad = words.filter(w => !/^[a-z]+$/.test(w) || realCount(tok, w) !== 3);
    expect(bad.slice(0, 10)).toEqual([]);
    expect(new Set(words).size).toBe(words.length);
    expect(words.length).toBeGreaterThan(20_000);
  });

  it.skipIf(!haveModel || !process.env.UPDATE_TOKEN_FIXTURE)("rewrites the fixture from the pinned tokenizer (UPDATE_TOKEN_FIXTURE=1)", async () => {
    const tok = await loadTokenizer();
    writeFileSync(fixturePath, `${JSON.stringify(Object.fromEntries(chunks.map(c => [hash(c.text), realCount(tok, c.text)])))}\n`);
  });
});
