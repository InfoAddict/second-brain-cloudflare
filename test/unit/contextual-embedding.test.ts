import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildDeterministicContext, buildEmbeddingChunks, estimateBgeSmallTokens, isContextEligible, type ContextEntry,
} from "../../src/capture/contextual";
import { storeEntry } from "../../src/capture/store";
import { DEFAULTS, type Config } from "../../src/config";
import { CHUNK_MAX_CHARS, CONTEXT_PREFIX_MAX_CHARS, CONTEXT_MAX_FOCUS_CHUNKS, CONTEXT_SMALL_BODY_START_CHARS, CONTEXT_SMALL_TARGET_TOKENS } from "../../src/constants";
import { chunkText } from "../../src/text/chunk";
import { makeTestEnv } from "../helpers/make-env";

const on: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "on" };
const off: Config = { ...DEFAULTS, CONTEXTUAL_EMBEDDINGS: "off" };
const M3 = "@cf/baai/bge-m3";
const CREATED = Date.UTC(2026, 8, 23, 23, 59);

const sentence = "The migration window closes on a Friday and every service owner signs off. ";
const longText = (n: number) => `Dashboard redesign. ${sentence.repeat(Math.ceil(n / sentence.length))}`.slice(0, n);
const entry = (over: Partial<ContextEntry> = {}): ContextEntry => ({
  id: "e1", content: longText(3300), tags: ["project:dashboard", "design", "kind:decision", "review"], source: "claude-desktop", createdAt: CREATED, ...over,
});

describe("buildDeterministicContext", () => {
  it("names the first line, project, topics, source, UTC date and part", () => {
    const p = buildDeterministicContext(entry(), 1, 4);
    expect(p).toBe("[Memory: Dashboard redesign. Project dashboard. Topics design, review. Source claude-desktop. Saved 2026-09-23. Part 2 of 4.]");
  });

  it("drops worker-owned tags and caps projects at two and topics at three", () => {
    const p = buildDeterministicContext(entry({ tags: ["project:a", "project:b", "project:c", "t1", "t2", "t3", "t4", "status:open"] }), 0, 2);
    expect(p).toContain("Project a, b.");
    expect(p).toContain("Topics t1, t2, t3.");
    expect(p).not.toMatch(/status|kind|project:c|t4/);
  });

  it("never exceeds the prefix cap, and always keeps the part number", () => {
    const p = buildDeterministicContext(entry({ content: `${"word ".repeat(60)}.\nbody`, source: "s".repeat(200), tags: Array(64).fill("verylongtopicname") }), 2, 9);
    expect(p.length).toBeLessThanOrEqual(CONTEXT_PREFIX_MAX_CHARS);
    expect(p).toContain("Part 3 of 9");
  });

  it("normalizes whitespace, skips empty first lines and ends the title at one sentence", () => {
    const p = buildDeterministicContext(entry({ content: "\n\n  Ship   the\tdashboard.  Then more text follows here.\nsecond line" }), 0, 2);
    expect(p).toContain("[Memory: Ship the dashboard. ");
    expect(p).not.toContain("Then more");
  });

  it("copes with an empty first line and a missing date", () => {
    expect(buildDeterministicContext(entry({ content: "", createdAt: NaN, source: "", tags: [] }), 0, 2)).toBe("[Memory: Part 1 of 2.]");
  });

  it("is deterministic", () => {
    expect(buildDeterministicContext(entry(), 0, 3)).toBe(buildDeterministicContext(entry(), 0, 3));
  });
});

describe("buildEmbeddingChunks", () => {
  it("returns today's chunks byte for byte when the switch is off", () => {
    const e = entry();
    const chunks = buildEmbeddingChunks(e, off);
    expect(chunks.map(c => c.embeddingText)).toEqual(chunkText(e.content));
    expect(chunks.every(c => !c.contextualized && c.contextSource === "none")).toBe(true);
  });

  it("leaves a single-chunk entry plain at exactly the 1,600 boundary and contextualizes 1,601", () => {
    const at = buildEmbeddingChunks(entry({ content: longText(CHUNK_MAX_CHARS) }), on);
    expect(at).toHaveLength(1);
    expect(at[0].embeddingText).toBe(longText(CHUNK_MAX_CHARS));
    expect(isContextEligible({ content: longText(CHUNK_MAX_CHARS), source: "x" })).toBe(false);
    const over = buildEmbeddingChunks(entry({ content: longText(CHUNK_MAX_CHARS + 1) }), on);
    expect(over.length).toBeGreaterThan(1);
    expect(over.every(c => c.contextualized)).toBe(true);
  });

  it("keeps a mirrored record to its plain first chunk", () => {
    const chunks = buildEmbeddingChunks(entry({ source: "email-gmail" }), on);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].embeddingText).toBe(chunkText(entry().content)[0]);
  });

  it("prefixes every chunk but keeps rawContent raw, covering the whole text with overlap", () => {
    const unique = `Dashboard redesign. ${Array.from({ length: 200 }, (_, i) => `Step ${i} of the rollout is owned by team ${i * 7}.`).join(" ")}`.slice(0, 5000);
    const e = entry({ content: unique });
    const chunks = buildEmbeddingChunks(e, on);
    for (const c of chunks) {
      expect(c.embeddingText.startsWith("[Memory: ")).toBe(true);
      expect(c.embeddingText.endsWith(c.rawContent)).toBe(true);
      expect(c.rawContent).not.toContain("[Memory:");
      expect(c.totalChunks).toBe(chunks.length);
    }
    // every raw character sits in some chunk, and neighbours overlap
    let cursor = 0;
    for (const [i, c] of chunks.entries()) {
      const at = e.content.indexOf(c.rawContent, Math.max(0, cursor - 400));
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(cursor);
      cursor = at + c.rawContent.length;
      if (i === chunks.length - 1) expect(cursor).toBe(e.content.trimEnd().length);
    }
  });

  it("cuts both models into focus chunks well under the plain 1,600 characters", () => {
    const e = entry({ content: longText(3200) });
    for (const model of [DEFAULTS.EMBEDDING_MODEL, M3]) {
      const chunks = buildEmbeddingChunks(e, { ...on, EMBEDDING_MODEL: model });
      expect(Math.max(...chunks.slice(0, CONTEXT_MAX_FOCUS_CHUNKS).map(c => c.rawContent.length))).toBeLessThanOrEqual(CONTEXT_SMALL_BODY_START_CHARS + 1);
      expect(chunks.length).toBeGreaterThan(chunkText(e.content).length);
    }
  });

  it("keeps vector growth for a long note bounded: at most 7 vectors for 3,200 characters", () => {
    expect(buildEmbeddingChunks(entry({ content: longText(3200) }), on).length).toBeLessThanOrEqual(CONTEXT_MAX_FOCUS_CHUNKS + 1);
  });

  it("fits token-dense text under the BGE Small target by splitting, never truncating", () => {
    const dense = `Dashboard. ${Array.from({ length: 900 }, (_, i) => `id${i}:0x${(i * 7919).toString(16)};`).join(" ")}`;
    const chunks = buildEmbeddingChunks(entry({ content: dense }), on);
    expect(chunks.length).toBeGreaterThan(chunkText(dense).length);
    for (const c of chunks) expect(estimateBgeSmallTokens(c.embeddingText)).toBeLessThanOrEqual(CONTEXT_SMALL_TARGET_TOKENS);
    expect(chunks.map(c => c.rawContent).join("")).toContain(dense.slice(-40));
  });

  it("handles CJK, long URLs and unbroken strings within budget", () => {
    for (const body of ["設計".repeat(2200), `see ${"https://example.com/a/b?c=d".repeat(120)}`, "x".repeat(4000)]) {
      const chunks = buildEmbeddingChunks(entry({ content: body }), on);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) expect(estimateBgeSmallTokens(c.embeddingText)).toBeLessThanOrEqual(CONTEXT_SMALL_TARGET_TOKENS);
    }
  });

  it("uses model-written context when given one sentence per chunk, else the deterministic prefix", () => {
    const e = entry();
    const n = buildEmbeddingChunks(e, on).length;
    const ctx = Array.from({ length: n }, (_, i) => `Sentence ${i}.`);
    const llm = buildEmbeddingChunks(e, on, ctx);
    expect(llm[1].embeddingText.startsWith("[Memory: Sentence 1.]\n")).toBe(true);
    expect(llm.every(c => c.contextSource === "llm")).toBe(true);
    const wrongLength = buildEmbeddingChunks(e, on, ["only one"]);
    expect(wrongLength[0].embeddingText).toContain("Part 1 of");
  });
});

describe("estimateBgeSmallTokens", () => {
  const samples: Record<string, string> = {
    prose: longText(1500),
    japanese: "設計のレビュー".repeat(120),
    hexIds: Array.from({ length: 300 }, (_, i) => `id${i}:0x${(i * 7919).toString(16)};`).join(" "),
    urls: "https://example.com/a/b?c=d&e=f#g ".repeat(40),
    unbroken: "x".repeat(1500),
    punctuation: "a, b; c! d? ".repeat(150),
    accents: "naïve café résumé ".repeat(80),
    uuids: "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c ".repeat(30),
    base64: "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q9PQ== ".repeat(30),
    camelCase: "getUserAccountBalanceHandler ".repeat(40),
  };
  const fixturePath = resolve(__dirname, "fixtures/bge-small-token-counts.json");
  const modelDir = resolve(__dirname, "../../.eval-cache/models/bge-small-en-v1.5-5c38ec7c405e");
  const haveModel = existsSync(resolve(modelDir, "tokenizer.json"));
  const load = async () => {
    const tf = await import("@huggingface/transformers");
    return tf.AutoTokenizer.from_pretrained(modelDir, { local_files_only: true });
  };
  const count = (tok: Awaited<ReturnType<typeof load>>, s: string) => (tok(s, { truncation: false }).input_ids.tolist() as number[][])[0].length;

  // The evidence lives in a committed fixture of real tokenizer counts, so this check does not depend on the model cache.
  it("never undercounts the recorded real BGE Small token counts", () => {
    const recorded = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, number>;
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(samples).sort());
    for (const [name, text] of Object.entries(samples)) expect(estimateBgeSmallTokens(text), name).toBeGreaterThanOrEqual(recorded[name]);
  });

  it.skipIf(!haveModel)("the fixture still matches the pinned tokenizer (skipped: .eval-cache/models is not present; run npm run test:eval:local-models to fetch it)", async () => {
    const tok = await load();
    const recorded = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, number>;
    for (const [name, text] of Object.entries(samples)) expect(recorded[name], name).toBe(count(tok, text));
  });

  it.skipIf(!haveModel || !process.env.UPDATE_TOKEN_FIXTURE)("rewrites the fixture from the pinned tokenizer (UPDATE_TOKEN_FIXTURE=1)", async () => {
    const tok = await load();
    writeFileSync(fixturePath, `${JSON.stringify(Object.fromEntries(Object.entries(samples).map(([n, t]) => [n, count(tok, t)])), null, 1)}\n`);
  });
});

describe("storeEntry with contextual embeddings", () => {
  const run = async (config: Config, e = entry(), source = e.source) => {
    const env = makeTestEnv();
    const embed = vi.spyOn(env.AI, "run");
    const stored = await storeEntry(env, e.id, e.content, e.tags, source, e.createdAt, config, { workspaceId: "w1", actorId: "a" });
    const vectors = (env.VECTORIZE.upsert as any).mock.calls[0][0] as { id: string; metadata: Record<string, any> }[];
    return { env, embed, stored, vectors };
  };

  it("embeds prefixed text but stores raw chunk content and context flags", async () => {
    const { embed, vectors } = await run(on);
    const sent = embed.mock.calls.map(c => (c[1] as any).text[0] as string);
    expect(sent.every(t => t.startsWith("[Memory: "))).toBe(true);
    expect(vectors.every(v => !v.metadata.content.includes("[Memory:"))).toBe(true);
    expect(vectors[0].metadata).toMatchObject({ parentId: "e1", workspace_id: "w1", contextualized: true, contextSource: "deterministic", scheme: 2, totalChunks: vectors.length });
    expect(vectors.map(v => v.id)).toEqual(vectors.map((_, i) => `e1-chunk-${i}`));
  });

  it("writes single-chunk entries exactly as before, with no scheme fields when the config is legacy", async () => {
    const short = entry({ content: "a short note" });
    const { vectors } = await run(off, short);
    expect(vectors).toHaveLength(1);
    expect(vectors[0].id).toBe("e1");
    expect(vectors[0].metadata).not.toHaveProperty("scheme");
    expect(vectors[0].metadata).not.toHaveProperty("contextualized");
  });

  it("stamps the scheme on a single-chunk vector when contextual is on, without changing its text", async () => {
    const short = entry({ content: "a short note" });
    const { vectors, embed } = await run(on, short);
    expect(vectors[0].metadata.scheme).toBe(2);
    expect((embed.mock.calls[0][1] as any).text[0]).toBe("a short note");
  });

  it("indexes a mirrored record as one plain first chunk", async () => {
    const { vectors, embed } = await run(on, entry(), "email-gmail");
    expect(vectors).toHaveLength(1);
    expect((embed.mock.calls[0][1] as any).text[0]).toBe(vectors[0].metadata.content);
  });

  it("falls back to plain chunks if building context throws, without failing the save", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await import("../../src/capture/contextual");
    const orig = mod.buildEmbeddingChunks;
    let calls = 0;
    const patched = vi.spyOn(mod, "buildEmbeddingChunks").mockImplementation((e, c, l) => {
      if (calls++ === 0) throw new Error("boom");
      return orig(e, c, l);
    });
    const { vectors, embed } = await run(on);
    patched.mockRestore(); spy.mockRestore();
    expect(vectors.length).toBeGreaterThan(1);
    expect((embed.mock.calls[0][1] as any).text[0]).not.toContain("[Memory:");
  });

  it("sends the cls pooling field only when configured, and never to bge-m3", async () => {
    const cls = await run({ ...off, EMBEDDING_POOLING: "cls" }, entry({ content: "hello" }));
    expect((cls.embed.mock.calls[0][1] as any).pooling).toBe("cls");
    const mean = await run(off, entry({ content: "hello" }));
    expect(mean.embed.mock.calls[0][1]).toEqual({ text: ["hello"] });
    const m3 = await run({ ...off, EMBEDDING_MODEL: M3, EMBEDDING_POOLING: "cls" }, entry({ content: "hello" }));
    expect(m3.embed.mock.calls[0][1]).toEqual({ text: ["hello"], truncate_inputs: true });
  });
});

// Reference implementations of the code the perf work replaced. The fast versions must agree with them exactly,
// except that any Unicode digit (not only 0-9) now marks a run as digit-bearing, which can only raise the estimate.
const refChunk = (text: string, maxChars = 1600, overlapChars = 200): string[] => {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChars;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxChars / 2) end = breakPoint + 1;
    }
    chunks.push(text.slice(start, Math.min(end, text.length)).trim());
    start = end - overlapChars;
  }
  return chunks.filter(c => c.length > 0);
};
const refEstimate = (text: string): number => {
  let tokens = 2;
  let run = "";
  const flush = () => {
    const len = run.length;
    if (len) tokens += /\p{N}/u.test(run) || len > 12 ? len : len > 6 ? Math.ceil(len / 2) : Math.ceil(len / 3);
    run = "";
  };
  for (const ch of text) {
    if (/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\u3040-\u30ff]/u.test(ch)) { flush(); tokens += 1; }
    else if (/[\p{L}\p{N}]/u.test(ch)) run += ch;
    else { flush(); if (!/\s/.test(ch)) tokens += 1; }
  }
  flush();
  return tokens;
};

describe("fast paths agree with the code they replaced", () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const alphabet = ["a", "b", "e", "Z", "7", "0", " ", " ", "\n", ".", ".", ",", "-", "é", "ß", "設", "計", "한", "😀", "𝟘", "\t", "\u00a0", "_"];
  const randomText = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");

  it("chunkText returns exactly the old chunks on random text of every shape", () => {
    for (let k = 0; k < 60; k++) {
      const text = randomText(Math.floor(rnd() * 6000));
      for (const [max, overlap] of [[1600, 200], [500, 50], [1200, 200], [300, 50]] as const) {
        expect(chunkText(text, max, overlap), `${k} ${max}`).toEqual(refChunk(text, max, overlap));
      }
    }
  });

  it("estimateBgeSmallTokens returns exactly the old count on random text, astral characters included", () => {
    for (let k = 0; k < 200; k++) {
      const text = randomText(Math.floor(rnd() * 1500));
      expect(estimateBgeSmallTokens(text), text.slice(0, 40)).toBe(refEstimate(text));
    }
  });

  it("notes over the size limit embed plain and are not context-eligible", () => {
    const big = longText(70_000);
    expect(isContextEligible({ content: big, source: "api" })).toBe(false);
    expect(buildEmbeddingChunks(entry({ content: big }), on).every(c => !c.contextualized)).toBe(true);
  });

  it("caps a note's focus chunks and cuts the rest at legacy size, covering every character", () => {
    const unique = `Dashboard redesign. ${Array.from({ length: 400 }, (_, i) => `Step ${i} of the rollout is owned by team ${i * 7}.`).join(" ")}`;
    const chunks = buildEmbeddingChunks(entry({ content: unique }), on);
    const short = chunks.filter(c => c.rawContent.length <= CONTEXT_SMALL_BODY_START_CHARS);
    expect(chunks.slice(0, CONTEXT_MAX_FOCUS_CHUNKS).every(c => c.rawContent.length <= CONTEXT_SMALL_BODY_START_CHARS + 1)).toBe(true);
    expect(chunks.slice(CONTEXT_MAX_FOCUS_CHUNKS).some(c => c.rawContent.length > CONTEXT_SMALL_BODY_START_CHARS)).toBe(true);
    expect(short.length).toBeGreaterThanOrEqual(CONTEXT_MAX_FOCUS_CHUNKS);
    expect(chunks.at(-1)!.rawContent.endsWith(unique.trimEnd().slice(-40))).toBe(true);
  });
});

describe("storeEntry upserts", () => {
  it("splits a note with more than 1,000 chunks into Vectorize-sized batches", async () => {
    const env = makeTestEnv();
    // Plain chunks (past the contextual size limit), about 1,400 of them.
    const content = `Big log. ${"word ".repeat(400_000)}`;
    const { vectorIds } = await storeEntry(env, "big", content, [], "api", 1, on);
    const calls = (env.VECTORIZE.upsert as any).mock.calls as unknown[][][];
    expect(vectorIds.length).toBeGreaterThan(1000);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c[0].length).toBeLessThanOrEqual(1000);
    expect(calls.reduce((n, c) => n + c[0].length, 0)).toBe(vectorIds.length);
  });
});
