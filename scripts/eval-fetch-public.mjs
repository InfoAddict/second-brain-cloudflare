#!/usr/bin/env node
// Downloads a public retrieval dataset and normalizes it to the neutral layout the eval reads.
// Usage: node scripts/eval-fetch-public.mjs <beir-scifact|miracl-ja> [--keep-raw]
// Everything lands under the git-ignored .eval-cache/public/; nothing is committed or redistributed.
// Every download is pinned to an immutable URL and verified against a sha256 before use.
//
// Licenses (checked Sep 23, 2026; local evaluation use only):
//  - BEIR SciFact: sources disagree (brief: CC BY-NC 2.0; allenai/scifact: claims CC BY 4.0, abstracts
//    ODC-By 1.0; BeIR/scifact HF card: CC BY-SA 4.0). Treat as non-commercial.
//  - MIRACL annotations and corpus: Apache-2.0 per the HF cards; passages are Wikipedia text (CC BY-SA 4.0).
//
// Raw MIRACL shards (~1 GB) are deleted after normalizing unless --keep-raw is passed, so a re-derive
// downloads them again. The pins make that safe; the normalized files stay in .eval-cache/public/<id>/.
//
// The SciFact source is pluggable: PINS["beir-scifact"] names a pinned archive and a `format`, and
// SCIFACT_PARSERS maps the format to a parser that writes the neutral layout. Switching to the allenai
// upstream release (https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz, license
// per allenai/scifact LICENSE.md) needs: (1) a new pinned url + sha256 (a .tar.gz, so extract with
// `tar -xzf` instead of `unzip`); (2) a parser for its layout: corpus.jsonl rows are
// {doc_id, title, abstract: [sentence, ...], structured}, so text = title + " " + abstract.join(" ");
// claims_{train,dev}.jsonl rows are {id, claim, evidence: {doc_id: [{sentences, label}]}, cited_doc_ids},
// so qrels are the evidence doc ids (label SUPPORT or CONTRADICT, score 1); claims_test.jsonl ships
// without evidence labels and cannot be used, so the judged set is train + dev (~1000 claims, not BEIR's
// test 300 + train 809). Ids become upstream doc_id/id values, so the derived hashes and any recorded
// baselines change.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const MIRACL_SEED = 20260923;
const HF = "https://huggingface.co/datasets";
const ANNOTATION_REV = "5be20db9509754dadad47689368639fcec739c00"; // miracl/miracl
const CORPUS_REV = "d921ec7e349ce0d28daf30b2da9da5ee698bef0d"; // miracl/miracl-corpus
// The shard sha256 values are the LFS object ids Hugging Face publishes for each file at CORPUS_REV.
const SHARD_SHA256 = [
  "c205bf3cece2098f3357fdb1b096e9ed0fd257632dd52b8d9095d01e07c61172", "2d1b8be5ab579604ccc483bebe170dec2b5d0fdcf54a7eb4d1f3dada72795306",
  "8992797e86cb16e9be395aae7c68ee2f7be043af638863fb0d36f6cdeb7a02a8", "8d0f12ce5aa5b3feca45c80ba4aed6abaa4a01d754e309bd8004bd8f181ba92b",
  "c32936efa13c72a32c75986dac3737c7d85db103ffabc7d8023320fac7446c57", "4fbf518b8ec8f57298fa23ffe52863410641173ee368a244863e60ed8b985e62",
  "6d55eb02dfa62b79662e3829a3ef223312374699d528b5af6643e0678bd6d517", "fe74fbd9c3965bffc848f74296e8f3fd7db9d63c1b4c62903d1a9779276a963c",
  "0abb18418c92d8013cad727dfffcc3fa719c14f818654f9800d7ebee8748f83a", "1129864292948a2c8d479aef61ba020d4870cabc3d28e3baed5c8cabee07fe98",
  "859b4cce1009e965e3663ce606d49de355ee82362028f6b6ecd0bf3f237b85ec", "216585793ed7c836eb66a4b5c982025e79a0d0184715d24a404ce0ee009931ce",
  "92a950e46775d5c2aebe5e58f1498ddcf16e3e35dafb07f4f04fd3cd9cb64ba3", "98acce36aa778df24f24be39965a2654cf7fbd923c09acc9eede8d91dc2b081a",
];

export const PINS = {
  "beir-scifact": {
    url: "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip",
    // Measured on first download (Sep 23, 2026); last-modified on the host is 2021-04-20.
    sha256: "536e14446a0ba56ed1398ab1055f39fe852686ecad24a6306c80c490fa8e0165",
    format: "beir",
  },
  "miracl-ja": {
    annotationRevision: ANNOTATION_REV,
    corpusRevision: CORPUS_REV,
    seed: MIRACL_SEED,
    topics: {
      url: `${HF}/miracl/miracl/resolve/${ANNOTATION_REV}/miracl-v1.0-ja/topics/topics.miracl-v1.0-ja-dev.tsv`,
      sha256: "1904b9bf0fc52e1b684daa7539b2bcfdd90122e603ffbcf6b5065a0e210525b0",
    },
    qrels: {
      url: `${HF}/miracl/miracl/resolve/${ANNOTATION_REV}/miracl-v1.0-ja/qrels/qrels.miracl-v1.0-ja-dev.tsv`,
      sha256: "1e2a60ba96b889bd076adea950e7e83a2d083f671955a5ab3e9bdc332b492e5f",
    },
    shards: SHARD_SHA256.map((sha256, i) => ({
      name: `docs-${i}.jsonl.gz`,
      url: `${HF}/miracl/miracl-corpus/resolve/${CORPUS_REV}/miracl-corpus-v1.0-ja/docs-${i}.jsonl.gz`,
      sha256,
    })),
  },
};

export async function sha256File(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

/** Downloads to dest, verifying sha256 before the file appears. A verified cached copy skips the network. */
export async function downloadPinned({ url, dest, sha256, fetchImpl = fetch }) {
  if (existsSync(dest) && (await sha256File(dest)) === sha256) return;
  const part = `${dest}.part`;
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${url}`);
  const h = createHash("sha256");
  const sink = createWriteStream(part);
  try {
    await pipeline(Readable.fromWeb(res.body), async function* (src) { for await (const c of src) { h.update(c); yield c; } }, sink);
    const got = h.digest("hex");
    if (got !== sha256) throw new Error(`checksum mismatch for ${url}: expected ${sha256}, got ${got}`);
    renameSync(part, dest);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}

/** Splits on "\n" only: readline also splits on U+2028/2029, which occur inside real passages. */
async function* gzipLines(path) {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  for await (const chunk of createReadStream(path).pipe(createGunzip())) {
    const parts = (carry + decoder.write(chunk)).split("\n");
    carry = parts.pop();
    yield* parts;
  }
  carry += decoder.end();
  if (carry) yield carry;
}

const readLines = path => readFileSync(path, "utf8").split("\n").filter(Boolean);
const writeAtomic = (path, data) => { writeFileSync(`${path}.part`, data); renameSync(`${path}.part`, path); };
const writeLines = (path, rows) => writeAtomic(path, rows.length ? rows.join("\n") + "\n" : "");
/** A stale manifest must not outlive a rewrite: without one the loader refuses the directory. */
const resetDerived = out => { mkdirSync(out, { recursive: true }); rmSync(resolve(out, "MANIFEST.json"), { force: true }); };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** BEIR SciFact -> neutral layout: test (300 claims) plus train (~800) qrels over the one 5,183-doc corpus. */
export function normalizeScifact({ base, out }) {
  resetDerived(out);
  const docs = readLines(resolve(base, "corpus.jsonl")).map(l => JSON.parse(l));
  const queries = readLines(resolve(base, "queries.jsonl")).map(l => JSON.parse(l));
  const qrelRows = ["test", "train"].flatMap(split => readLines(resolve(base, `qrels/${split}.tsv`)).slice(1)); // drop each header
  // BEIR convention: title + " " + abstract (titles usually end in "." already).
  writeLines(resolve(out, "corpus.jsonl"), docs.map(d => JSON.stringify({ id: d._id, text: d.title ? `${d.title} ${d.text}` : d.text })));
  writeLines(resolve(out, "queries.jsonl"), queries.map(q => JSON.stringify({ id: q._id, text: q.text })));
  writeLines(resolve(out, "qrels.tsv"), ["query-id\tcorpus-id\tscore", ...qrelRows]);
  const judged = new Set(qrelRows.map(l => l.split("\t")).filter(([q, , sc]) => q && Number(sc) > 0).map(([q]) => q));
  return { docs: docs.length, queries: queries.length, judgedQueries: judged.size };
}

/** Source format -> parser; a new SciFact source registers a parser here and a pin in PINS. */
export const SCIFACT_PARSERS = { beir: normalizeScifact };

const rank = (seed, kind, id) => createHash("sha256").update(`${seed}:${kind}:${id}`).digest("hex");
const BINS = 10;

/** Probability that a random positive is longer than a random distractor (ties count half). 0.5 = length carries no signal. */
function lengthAuc(positive, distractor) {
  const sorted = [...distractor].sort((a, b) => a - b);
  const lowerBound = x => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
  let wins = 0;
  for (const x of positive) { const lo = lowerBound(x), hi = lowerBound(x + 1); wins += lo + (hi - lo) / 2; }
  return wins / (positive.length * sorted.length);
}

/**
 * MIRACL dev split -> neutral layout, sampled by seeded hash so the result does not depend on shard order.
 * Queries: the maxQueries dev queries with a positive, smallest hash first. Docs: every passage judged for
 * them (positives and negatives), plus distractors chosen per length decile of the judged passages
 * (quota proportional to the judged share, smallest hash first) so length alone does not separate
 * positives from distractors. Two passes over the shards: judged passages first, then distractors.
 * Throws if distractors would fall below minDistractorShare of maxDocs.
 */
export async function normalizeMiracl({ topicsPath, qrelsPath, shardPaths, out, seed = MIRACL_SEED, maxQueries = 860, maxDocs = 13500, minDistractorShare = 0.3 }) {
  resetDerived(out);
  const topics = new Map(readLines(topicsPath).map(l => l.split("\t")).map(([id, ...q]) => [id, q.join("\t")]));
  const judgments = new Map(); // qid -> [{ docid, score }]
  for (const line of readLines(qrelsPath)) {
    const [qid, , docid, score] = line.split("\t");
    if (!topics.has(qid)) continue;
    (judgments.get(qid) ?? judgments.set(qid, []).get(qid)).push({ docid, score: Number(score) });
  }
  const chosen = [...judgments.keys()]
    .filter(q => judgments.get(q).some(j => j.score > 0))
    .sort((a, b) => cmp(rank(seed, "q", a), rank(seed, "q", b)))
    .slice(0, maxQueries)
    .sort();
  const judgedIds = new Set(chosen.flatMap(q => judgments.get(q).map(j => j.docid)));
  const positiveIds = new Set(chosen.flatMap(q => judgments.get(q).filter(j => j.score > 0).map(j => j.docid)));
  const want = maxDocs - judgedIds.size;
  if (want < maxDocs * minDistractorShare) {
    throw new Error(`only ${Math.max(0, want)} distractors of ${maxDocs} docs (${judgedIds.size} judged), below the ${minDistractorShare} distractor share floor: raise maxDocs`);
  }

  // Pass 1: judged passages.
  const judgedDocs = new Map();
  for (const shard of shardPaths) for await (const line of gzipLines(shard)) {
    if (!line) continue;
    const d = JSON.parse(line);
    if (judgedIds.has(d.docid)) judgedDocs.set(d.docid, `${d.title}. ${d.text}`);
  }
  for (const q of chosen) for (const j of judgments.get(q)) {
    if (j.score > 0 && !judgedDocs.has(j.docid)) throw new Error(`positive passage ${j.docid} for query ${q} not found in the corpus shards`);
  }
  // Negatives missing from the shards are dropped: only positives must exist for a query to be answerable.
  const judgedLens = [...judgedDocs.values()].map(t => t.length).sort((a, b) => a - b);
  const edges = Array.from({ length: BINS - 1 }, (_, k) => judgedLens[Math.floor(((k + 1) * judgedLens.length) / BINS)]);
  const minLen = judgedLens[0], maxLen = judgedLens.at(-1);
  const binOf = len => edges.filter(e => e < len).length;
  const counts = Array(BINS).fill(0);
  for (const len of judgedLens) counts[binOf(len)]++;
  // Largest-remainder quotas, ties by bin index.
  const quota = counts.map(c => Math.floor((want * c) / judgedLens.length));
  const order = counts.map((c, b) => ({ b, rem: (want * c) % judgedLens.length })).sort((x, y) => y.rem - x.rem || x.b - y.b);
  for (let i = 0; i < want - quota.reduce((a, b) => a + b, 0); i++) quota[order[i].b]++;

  // Pass 2: distractors, per bin, smallest hash first; outside the judged length range is ineligible.
  const pools = Array.from({ length: BINS }, () => []);
  const cutoffs = Array(BINS).fill("\uffff");
  const trim = b => { pools[b].sort((x, y) => cmp(x.r, y.r)); pools[b] = pools[b].slice(0, quota[b]); cutoffs[b] = quota[b] > 0 && pools[b].length >= quota[b] ? pools[b].at(-1).r : "\uffff"; };
  for (const shard of shardPaths) for await (const line of gzipLines(shard)) {
    if (!line) continue;
    const d = JSON.parse(line);
    if (judgedIds.has(d.docid)) continue;
    const text = `${d.title}. ${d.text}`;
    if (text.length < minLen || text.length > maxLen) continue;
    const b = binOf(text.length);
    if (quota[b] === 0) continue;
    const r = rank(seed, "d", d.docid);
    if (!(r < cutoffs[b])) continue;
    pools[b].push({ r, id: d.docid, text });
    if (pools[b].length >= quota[b] * 2 + 64) trim(b);
  }
  for (let b = 0; b < BINS; b++) trim(b);
  const distractors = pools.flat();
  if (distractors.length < maxDocs * minDistractorShare) {
    throw new Error(`sampled ${distractors.length} distractors of ${maxDocs} docs, below the ${minDistractorShare} distractor share floor`);
  }

  const rows = [...judgedDocs].map(([id, text]) => ({ r: rank(seed, "d", id), id, text })).concat(distractors).sort((a, b) => cmp(a.r, b.r));
  writeLines(resolve(out, "corpus.jsonl"), rows.map(d => JSON.stringify({ id: d.id, text: d.text })));
  writeLines(resolve(out, "queries.jsonl"), chosen.map(q => JSON.stringify({ id: q, text: topics.get(q) })));
  writeLines(resolve(out, "qrels.tsv"), ["query-id\tcorpus-id\tscore", ...chosen.flatMap(q => judgments.get(q).filter(j => j.score > 0 && judgedDocs.has(j.docid)).map(j => `${q}\t${j.docid}\t${j.score}`))]);
  const auc = lengthAuc([...positiveIds].map(id => judgedDocs.get(id).length), distractors.map(d => d.text.length));
  return { docs: rows.length, queries: chosen.length, judgedDocs: judgedDocs.size, distractors: distractors.length, lengthAuc: Math.round(auc * 1000) / 1000 };
}

const sha256Text = path => createHash("sha256").update(readFileSync(path)).digest("hex");

export function writeManifest(out, dataset, pin, counts) {
  writeFileSync(resolve(out, "MANIFEST.json"), JSON.stringify({
    dataset, fetchedAt: new Date().toISOString(), pin, counts,
    derived: Object.fromEntries(["corpus.jsonl", "queries.jsonl", "qrels.tsv"].map(f => [f, sha256Text(resolve(out, f))])),
  }, null, 2) + "\n");
}

async function main(argv) {
  const [dataset, ...flags] = argv;
  const out = resolve(root, ".eval-cache/public", dataset ?? "");
  const raw = resolve(out, "raw");
  if (dataset === "beir-scifact") {
    mkdirSync(raw, { recursive: true });
    const zip = resolve(raw, "scifact.zip");
    await downloadPinned({ url: PINS[dataset].url, dest: zip, sha256: PINS[dataset].sha256 });
    const unzip = spawnSync("unzip", ["-oq", zip, "-d", raw]);
    if (unzip.status !== 0) throw new Error("unzip failed (is the unzip binary installed?)");
    const counts = SCIFACT_PARSERS[PINS[dataset].format]({ base: resolve(raw, "scifact"), out });
    writeManifest(out, dataset, PINS[dataset], counts);
    console.log(`wrote ${out}`, counts);
  } else if (dataset === "miracl-ja") {
    const pin = PINS[dataset];
    mkdirSync(raw, { recursive: true });
    const topicsPath = resolve(raw, "topics.tsv");
    const qrelsPath = resolve(raw, "qrels.tsv");
    await downloadPinned({ ...pin.topics, dest: topicsPath });
    await downloadPinned({ ...pin.qrels, dest: qrelsPath });
    const shardPaths = [];
    for (const s of pin.shards) {
      const dest = resolve(raw, s.name);
      console.log(`fetching ${s.name}`);
      await downloadPinned({ url: s.url, sha256: s.sha256, dest });
      shardPaths.push(dest);
    }
    const counts = await normalizeMiracl({ topicsPath, qrelsPath, shardPaths, out, seed: pin.seed, maxQueries: 860, maxDocs: 13500 });
    writeManifest(out, dataset, pin, counts);
    if (!flags.includes("--keep-raw")) for (const p of shardPaths) rmSync(p);
    console.log(`wrote ${out}`, counts);
  } else {
    console.error("usage: node scripts/eval-fetch-public.mjs <beir-scifact|miracl-ja> [--keep-raw]");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
