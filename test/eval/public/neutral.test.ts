import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { WORKSPACES } from "../corpus/types";
import { loadNeutralCorpus, PUBLIC_CORPORA, publicCorpusProvider } from "./neutral";
import { cleanTemp } from "../../helpers/tmp";

afterEach(cleanTemp);

/** Writes MANIFEST.json the way the fetch script does: sha256 of each derived file. */
function writeManifest(dir: string) {
  const derived = Object.fromEntries(["corpus.jsonl", "queries.jsonl", "qrels.tsv"].map(f => [f, createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")]));
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ derived }));
}

// d25 sits beyond a naive slice(0, maxDocs) so truncation must keep judged documents on purpose.
function fixture(qrels = "query-id\tcorpus-id\tscore\nq1\td25\t1\nq1\td4\t2\nq2\td9\t1\nq3\td1\t0\n") {
  const dir = mkdtempSync(join(tmpdir(), "neutral-"));
  mkdirSync(dir, { recursive: true });
  const docs = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, text: `document number ${i} about topic ${i % 5}` }));
  writeFileSync(join(dir, "corpus.jsonl"), docs.map(d => JSON.stringify(d)).join("\n"));
  writeFileSync(join(dir, "queries.jsonl"), ["q1", "q2", "q3"].map(id => JSON.stringify({ id, text: `question ${id}` })).join("\n"));
  writeFileSync(join(dir, "qrels.tsv"), qrels);
  writeManifest(dir);
  return dir;
}

describe("loadNeutralCorpus", () => {
  it("builds entries in one workspace, grades gold by score, and drops queries without positive judgments", () => {
    const spec = loadNeutralCorpus({ id: "scifact", dir: fixture(), category: "paraphrase" });
    expect(spec.entries).toHaveLength(30);
    expect(spec.entries.every(e => e.workspaceId === WORKSPACES.avery)).toBe(true);
    expect(spec.queries.map(q => q.id)).toEqual(["q1", "q2"]);
    expect(spec.queries[0].gold).toEqual([{ id: "d25", grade: 1 }, { id: "d4", grade: 2 }]);
    expect(spec.queries[0]).toMatchObject({ category: "paraphrase", viewer: "avery", tags: ["public"] });
  });

  it("carries the derived-manifest hashes as the corpus fingerprint", () => {
    const dir = fixture();
    const derived = (JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8")) as { derived: Record<string, string> }).derived;
    expect(loadNeutralCorpus({ id: "scifact", dir, category: "paraphrase" }).dataFingerprint).toEqual(derived);
  });

  it("is deterministic and keeps every judged document when truncating", () => {
    const dir = fixture();
    const a = loadNeutralCorpus({ id: "x", dir, category: "cjk", maxDocs: 10 });
    const b = loadNeutralCorpus({ id: "x", dir, category: "cjk", maxDocs: 10 });
    expect(a).toEqual(b);
    expect(a.entries).toHaveLength(10);
    for (const id of ["d25", "d4", "d9"]) expect(a.entries.some(e => e.id === id), id).toBe(true);
  });

  it("caps queries", () => {
    expect(loadNeutralCorpus({ id: "x", dir: fixture(), category: "paraphrase", maxQueries: 1 }).queries).toHaveLength(1);
  });

  it("fails loudly when a judgment points at a document the corpus lacks", () => {
    expect(() => loadNeutralCorpus({ id: "x", dir: fixture("q1\tmissing\t1\n"), category: "paraphrase" })).toThrow(/missing/);
  });

  it("fails with a fetch hint when the neutral files are absent", () => {
    expect(() => loadNeutralCorpus({ id: "scifact", dir: join(tmpdir(), "no-such-neutral-dir"), category: "paraphrase" })).toThrow(/eval-fetch-public/);
  });

  it("rejects a truncated or edited corpus.jsonl and tells the developer to re-fetch", () => {
    const dir = fixture();
    const file = join(dir, "corpus.jsonl");
    const whole = readFileSync(file, "utf8");
    writeFileSync(file, whole.slice(0, whole.length / 2));
    expect(() => loadNeutralCorpus({ id: "scifact", dir, category: "paraphrase" })).toThrow(/corpus\.jsonl.*re-run.*eval-fetch-public\.mjs scifact/is);
    writeFileSync(file, whole.replace("document number 3 ", "document number 3X "));
    expect(() => loadNeutralCorpus({ id: "scifact", dir, category: "paraphrase" })).toThrow(/corpus\.jsonl/);
  });

  it("rejects an edited qrels.tsv and a missing manifest", () => {
    const dir = fixture();
    writeFileSync(join(dir, "qrels.tsv"), "q1\td5\t1\n");
    expect(() => loadNeutralCorpus({ id: "x", dir, category: "paraphrase" })).toThrow(/qrels\.tsv/);
    const bare = fixture();
    writeFileSync(join(bare, "MANIFEST.json"), "{}");
    expect(() => loadNeutralCorpus({ id: "x", dir: bare, category: "paraphrase" })).toThrow(/re-run/i);
  });

  it("dates every entry at or before the frozen clock", () => {
    const { entries } = loadNeutralCorpus({ id: "x", dir: fixture(), category: "paraphrase" });
    for (const e of entries) expect(e.createdAt).toBeLessThanOrEqual(Date.UTC(2026, 8, 1));
  });
});

describe("publicCorpusProvider", () => {
  it("matches only the two public ids and loads them from the given root", () => {
    const root = mkdtempSync(join(tmpdir(), "neutral-root-"));
    const dir = join(root, ".eval-cache", "public", "scifact");
    mkdirSync(dir, { recursive: true });
    for (const f of ["corpus.jsonl", "queries.jsonl", "qrels.tsv"]) writeFileSync(join(dir, f), "");
    writeFileSync(join(dir, "corpus.jsonl"), JSON.stringify({ id: "a", text: "alpha" }) + "\n");
    writeFileSync(join(dir, "queries.jsonl"), JSON.stringify({ id: "q", text: "alpha?" }) + "\n");
    writeFileSync(join(dir, "qrels.tsv"), "q\ta\t1\n");
    writeManifest(dir);
    const p = publicCorpusProvider(root);
    expect(p.name).toBe("public");
    expect(Object.keys(PUBLIC_CORPORA).sort()).toEqual(["miracl-ja", "scifact"]);
    expect(p.match("scifact")).toBe(true);
    expect(p.match("miracl-ja")).toBe(true);
    expect(p.match("core-1k")).toBe(false);
    expect(p.match("toString")).toBe(false);
    expect(p.build("scifact").queries).toHaveLength(1);
  });

  it("keeps each corpus under 15k docs and queries above the power floor", () => {
    for (const c of Object.values(PUBLIC_CORPORA)) expect(c.maxDocs).toBeLessThan(15_000);
    expect(PUBLIC_CORPORA["miracl-ja"].maxQueries).toBeGreaterThanOrEqual(860);
    expect(PUBLIC_CORPORA["scifact"].maxQueries).toBeGreaterThanOrEqual(693);
  });

  it("records the embedding model each corpus needs", () => {
    expect(PUBLIC_CORPORA["scifact"].embeddingModel).toBe("@cf/baai/bge-small-en-v1.5");
    expect(PUBLIC_CORPORA["miracl-ja"].embeddingModel).toBe("@cf/baai/bge-m3");
  });
});
