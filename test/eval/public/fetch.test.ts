import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { downloadPinned, normalizeMiracl, normalizeScifact, PINS, sha256File, writeManifest } from "../../../scripts/eval-fetch-public.mjs";
import { loadNeutralCorpus } from "./neutral";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);

describe("pins", () => {
  it("pins every download to a sha256 and an immutable URL", () => {
    expect(PINS["scifact"].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(PINS["scifact"].url).toMatch(/^https:\/\/.*\?versionId=[\w.]+$/); // an S3 object version, not the overwritable "latest" key
    const m = PINS["miracl-ja"];
    expect(m.corpusRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(m.annotationRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(m.shards).toHaveLength(14);
    for (const s of m.shards) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.qrels.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.topics.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const url of [m.qrels.url, m.topics.url, ...m.shards.map((s: { url: string }) => s.url)]) expect(url).not.toContain("/main/");
  });
});

describe("downloadPinned", () => {
  const body = Buffer.from("hello dataset");
  const okFetch = async () => new Response(body, { status: 200 });

  it("writes the file only after the checksum matches", async () => {
    const dest = join(tmp("dl-"), "f.bin");
    await downloadPinned({ url: "https://example.test/f", dest, sha256: sha(body), fetchImpl: okFetch });
    expect(readFileSync(dest)).toEqual(body);
    expect(await sha256File(dest)).toBe(sha(body));
  });

  it("rejects a checksum mismatch and leaves no file behind", async () => {
    const dest = join(tmp("dl-"), "f.bin");
    await expect(downloadPinned({ url: "https://example.test/f", dest, sha256: sha("other"), fetchImpl: okFetch })).rejects.toThrow(/checksum/i);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("skips the network when a verified copy is already cached", async () => {
    const dest = join(tmp("dl-"), "f.bin");
    writeFileSync(dest, body);
    const failing = async () => { throw new Error("network touched"); };
    await downloadPinned({ url: "https://example.test/f", dest, sha256: sha(body), fetchImpl: failing });
  });

  it("re-downloads a cached copy that fails verification", async () => {
    const dest = join(tmp("dl-"), "f.bin");
    writeFileSync(dest, "corrupt");
    await downloadPinned({ url: "https://example.test/f", dest, sha256: sha(body), fetchImpl: okFetch });
    expect(readFileSync(dest)).toEqual(body);
  });

  it("removes a stale destination and the .part file when the re-download also mismatches", async () => {
    const dest = join(tmp("dl-"), "f.bin");
    writeFileSync(dest, "corrupt");
    await expect(downloadPinned({ url: "https://example.test/f", dest, sha256: sha(body), fetchImpl: async () => new Response("still wrong", { status: 200 }) })).rejects.toThrow(/checksum/i);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("removes a stale destination when the re-download fails outright", async () => {
    const dest = join(tmp("dl-"), "f.bin");
    writeFileSync(dest, "corrupt");
    await expect(downloadPinned({ url: "https://example.test/f", dest, sha256: sha(body), fetchImpl: async () => new Response("no", { status: 503 }) })).rejects.toThrow(/503/);
    expect(existsSync(dest)).toBe(false);
  });

  it("fails on a non-200 response", async () => {
    const dest = join(tmp("dl-"), "f.bin");
    await expect(downloadPinned({ url: "https://example.test/f", dest, sha256: sha(body), fetchImpl: async () => new Response("no", { status: 404 }) })).rejects.toThrow(/404/);
  });
});

describe("normalizeScifact", () => {
  function source(title = "Alpha") {
    const base = tmp("scifact-src-");
    writeFileSync(join(base, "corpus.jsonl"), [
      { doc_id: 1, title, abstract: ["First sentence.", "Second sentence."], structured: false },
      { doc_id: 2, title: "Beta.", abstract: ["Only one."], structured: false },
      { doc_id: 3, title: "", abstract: ["Untitled abstract."], structured: false },
    ].map(r => JSON.stringify(r)).join("\n"));
    writeFileSync(join(base, "claims_train.jsonl"), [
      { id: 10, claim: "claim ten", evidence: { "2": [{ sentences: [0], label: "SUPPORT" }] }, cited_doc_ids: [2] },
      { id: 11, claim: "claim eleven", evidence: {}, cited_doc_ids: [1] }, // NOT_ENOUGH_INFO: cited, not relevant
    ].map(r => JSON.stringify(r)).join("\n"));
    writeFileSync(join(base, "claims_dev.jsonl"), [
      { id: 12, claim: "claim twelve", evidence: { "1": [{ sentences: [1], label: "CONTRADICT" }], "3": [{ sentences: [0], label: "SUPPORT" }] }, cited_doc_ids: [1, 3] },
    ].map(r => JSON.stringify(r)).join("\n"));
    return base;
  }

  it("judges train plus dev claims by their evidence docs, dropping claims without evidence", () => {
    const out = tmp("scifact-out-");
    const counts = normalizeScifact({ base: source(), out });
    expect(counts).toEqual({ docs: 3, queries: 2, judgedQueries: 2, judgments: 3 });
    writeManifest(out, "scifact", {}, counts);
    const spec = loadNeutralCorpus({ id: "scifact", dir: out, category: "paraphrase" });
    expect(spec.queries.map(q => [q.id, q.gold])).toEqual([["10", [{ id: "2", grade: 1 }]], ["12", [{ id: "1", grade: 1 }, { id: "3", grade: 1 }]]]);
  });

  it("joins title and abstract sentences with single spaces, never doubling a title's period", () => {
    const out = tmp("scifact-out-");
    normalizeScifact({ base: source(), out });
    const text = Object.fromEntries(lines(join(out, "corpus.jsonl")).map(l => JSON.parse(l)).map(d => [d.id, d.text]));
    expect(text).toEqual({ "1": "Alpha First sentence. Second sentence.", "2": "Beta. Only one.", "3": "Untitled abstract." });
  });

  it("rejects evidence that names a doc missing from the corpus", () => {
    const base = source();
    writeFileSync(join(base, "claims_dev.jsonl"), JSON.stringify({ id: 12, claim: "c", evidence: { "99": [{ sentences: [0], label: "SUPPORT" }] } }));
    expect(() => normalizeScifact({ base, out: tmp("scifact-out-") })).toThrow(/99/);
  });

  it("rejects duplicate corpus doc ids", () => {
    const base = source();
    writeFileSync(join(base, "corpus.jsonl"), [1, 2, 1].map(doc_id => JSON.stringify({ doc_id, title: "T", abstract: ["a"] })).join("\n"));
    expect(() => normalizeScifact({ base, out: tmp("scifact-out-") })).toThrow(/duplicate.*doc.*1/i);
  });

  it("rejects a claim id repeated across train and dev", () => {
    const base = source();
    writeFileSync(join(base, "claims_dev.jsonl"), JSON.stringify({ id: 10, claim: "c", evidence: { "1": [{ sentences: [0], label: "SUPPORT" }] } }));
    expect(() => normalizeScifact({ base, out: tmp("scifact-out-") })).toThrow(/duplicate/);
  });

  it("writes atomically (no .part left) and drops a stale manifest before rewriting", () => {
    const out = tmp("scifact-out-");
    writeFileSync(join(out, "MANIFEST.json"), "{}");
    normalizeScifact({ base: source(), out });
    expect(existsSync(join(out, "MANIFEST.json"))).toBe(false);
    expect(readdirSync(out).filter(f => f.endsWith(".part"))).toEqual([]);
  });
});

describe("normalizeMiracl", () => {
  // 4 queries (1, 2, 4 have positives; 3 has only a negative) over 300 passages in two shards.
  // Passage length is 10 + (i % 20) chars of filler, so every length appears 15 times.
  const doc = (i: number) => ({ docid: `${1000 + i}#0`, title: "T", text: i === 3 ? "\u2028".padEnd(10 + (i % 20), "あ") : "あ".repeat(10 + (i % 20)) });
  function fixture(extra: { docid: string; title: string; text: string }[] = [], qrelRows?: string[]) {
    const dir = tmp("miracl-src-");
    const all = [...Array.from({ length: 300 }, (_, i) => doc(i)), ...extra];
    const shardA = join(dir, "docs-0.jsonl.gz");
    const shardB = join(dir, "docs-1.jsonl.gz");
    writeFileSync(shardA, gzipSync(all.slice(0, 120).map(d => JSON.stringify(d)).join("\n")));
    writeFileSync(shardB, gzipSync(all.slice(120).map(d => JSON.stringify(d)).join("\n")));
    const topics = join(dir, "topics.tsv");
    writeFileSync(topics, "1\t質問一\n2\t質問二\n3\t質問三\n4\t質問四\n");
    const qrels = join(dir, "qrels.tsv");
    writeFileSync(qrels, (qrelRows ?? ["1\tQ0\t1003#0\t1", "1\tQ0\t1140#0\t0", "2\tQ0\t1030#0\t1", "2\tQ0\t1077#0\t0", "3\tQ0\t1050#0\t0", "4\tQ0\t1211#0\t1", "4\tQ0\t1256#0\t0"]).join("\n") + "\n");
    return { topicsPath: topics, qrelsPath: qrels, shards: [shardA, shardB] };
  }
  const run = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) => {
    const out = tmp("miracl-out-");
    return normalizeMiracl({ topicsPath: f.topicsPath, qrelsPath: f.qrelsPath, shardPaths: f.shards, out, seed: 7, maxQueries: 300, maxDocs: 40, ...extra })
      .then((counts: { docs: number; queries: number; judgedDocs: number; distractors: number; lengthAuc: number }) => ({ out, counts }));
  };
  const corpus = (out: string) => lines(join(out, "corpus.jsonl")).map(l => JSON.parse(l) as { id: string; text: string });

  it("rejects a judged passage id that appears twice in the shards", async () => {
    await expect(run(fixture([{ docid: "1003#0", title: "T", text: "あ".repeat(12) }]))).rejects.toThrow(/duplicate.*1003#0/i);
  });

  it("keeps positives-bearing queries, every judged passage, and fills up to maxDocs with distractors", async () => {
    const { out, counts } = await run(fixture());
    // A sparse length bin in this tiny fixture can leave the sample a couple short; real shards never do.
    expect(counts).toMatchObject({ queries: 3, judgedDocs: 6 });
    expect(counts.docs).toBe(counts.judgedDocs + counts.distractors);
    expect(counts.docs).toBeGreaterThanOrEqual(36);
    expect(counts.docs).toBeLessThanOrEqual(40);
    writeManifest(out, "miracl-ja", {}, counts);
    const spec = loadNeutralCorpus({ id: "miracl-ja", dir: out, category: "cjk" });
    expect(spec.queries.map(q => q.id).sort()).toEqual(["1", "2", "4"]);
    const ids = new Set(spec.entries.map(e => e.id));
    for (const id of ["1003#0", "1140#0", "1030#0", "1077#0", "1211#0", "1256#0"]) expect(ids.has(id), id).toBe(true);
    expect(ids.has("1050#0")).toBe(false); // judged only for the query that has no positive
    expect(spec.entries.find(e => e.id === "1003#0")?.content).toContain("\u2028");
    expect(spec.queries.find(q => q.id === "1")?.gold).toEqual([{ id: "1003#0", grade: 1 }]);
  });

  it("is seeded: same seed gives identical bytes regardless of shard order, another seed differs", async () => {
    const f = fixture();
    const a = await run(f);
    const b = await run({ ...f, shards: [...f.shards].reverse() });
    const c = await run(f, { seed: 8 });
    const file = (o: { out: string }) => readFileSync(join(o.out, "corpus.jsonl"), "utf8");
    expect(file(a)).toBe(file(b));
    expect(readFileSync(join(a.out, "qrels.tsv"), "utf8")).toBe(readFileSync(join(b.out, "qrels.tsv"), "utf8"));
    expect(file(c)).not.toBe(file(a));
  });

  it("samples distractors length-matched to the judged passages (stratified by decile)", async () => {
    // Judged lengths span 10-29 chars. Short (5) and huge (2000) passages must never be sampled.
    const extra = [
      ...Array.from({ length: 100 }, (_, i) => ({ docid: `9${i}#0`, title: "T", text: "あ".repeat(5) })),
      ...Array.from({ length: 100 }, (_, i) => ({ docid: `8${i}#0`, title: "T", text: "あ".repeat(2000) })),
    ];
    const { out, counts } = await run(fixture(extra), { maxDocs: 60 });
    const lens = corpus(out).map(d => d.text.length);
    expect(Math.min(...lens)).toBeGreaterThanOrEqual(13); // "T. " prefix + 10
    expect(Math.max(...lens)).toBeLessThanOrEqual(32);
    expect(counts.docs).toBeGreaterThanOrEqual(55);
    expect(Math.abs(counts.lengthAuc - 0.5)).toBeLessThan(0.2);
  });

  it("refuses a sample whose distractor share falls below the floor", async () => {
    await expect(run(fixture(), { maxDocs: 8 })).rejects.toThrow(/distractor/i);
    await expect(run(fixture(), { maxDocs: 12, minDistractorShare: 0.6 })).rejects.toThrow(/distractor/i);
  });

  it("caps queries by seeded hash order and shrinks the judged set with them", async () => {
    const { counts, out } = await run(fixture(), { maxQueries: 1 });
    expect(counts.queries).toBe(1);
    expect(lines(join(out, "queries.jsonl"))).toHaveLength(1);
  });

  it("throws when a positive passage is absent from the corpus shards", async () => {
    const f = fixture([], ["1\tQ0\t9999#0\t1"]);
    await expect(run(f)).rejects.toThrow(/9999#0/);
  });

  it("writes atomically and drops a stale manifest before rewriting", async () => {
    const out = tmp("miracl-out-");
    writeFileSync(join(out, "MANIFEST.json"), "{}");
    const f = fixture();
    await normalizeMiracl({ topicsPath: f.topicsPath, qrelsPath: f.qrelsPath, shardPaths: f.shards, out, seed: 7, maxQueries: 300, maxDocs: 40 });
    expect(existsSync(join(out, "MANIFEST.json"))).toBe(false);
    expect(readdirSync(out).filter(f => f.endsWith(".part"))).toEqual([]);
  });
});
