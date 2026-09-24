import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ReplayStore, makeReplayAi, producerId, replayKey } from "./ai-replay";
import { producerFromCache, stampCache } from "./stamp";
import { UsageError, main, parseCli } from "./cli";
import type { EmbeddingProducer } from "./types";

const MODEL = "@cf/baai/bge-small-en-v1.5";
const P: EmbeddingProducer = { kind: "local-transformers-js", library: "@huggingface/transformers", libraryVersion: "4.3.0", onnxRuntime: "onnxruntime-node@1.30.0", repo: "BAAI/bge-small-en-v1.5", revision: "abc", dtype: "fp32" };
const f32 = Buffer.from(new Float32Array([1, 2]).buffer).toString("base64");
const legacy = (t: string) => JSON.stringify({ k: replayKey(MODEL, { text: [t] }), v: { f32: [f32] } });
const header = (model = MODEL, p = P) => JSON.stringify({ producer: { model, ...p } });
const tmp = () => { const root = mkdtempSync(join(tmpdir(), "stamp-")); mkdirSync(join(root, ".eval-cache"), { recursive: true }); return root; };

describe("stampCache", () => {
  it("stamps legacy rows so the file loads and serves them as verified; a second run is a no-op", async () => {
    const root = tmp(), file = join(root, ".eval-cache", "c.jsonl");
    writeFileSync(file, [header(), legacy("a"), legacy("b")].join("\n") + "\n");
    expect(() => makeReplayAi({ store: new ReplayStore([file], undefined, { root }), mode: "replay" }).ai.run(MODEL as never, { text: ["a"] } as never)).rejects.toThrow(/unverified/);
    expect(stampCache({ file, model: MODEL, producer: P })).toEqual({ stamped: 2, already: 0 });
    const ai = makeReplayAi({ store: new ReplayStore([file], undefined, { root }), mode: "replay" });
    await expect(ai.ai.run(MODEL as never, { text: ["a"] } as never)).resolves.toBeDefined();
    expect(ai.producers()).toEqual({ [MODEL]: P });
    expect(readFileSync(file, "utf8")).toContain(`"p":"${producerId(P)}"`);
    expect(readFileSync(file, "utf8")).toContain('"assertion":"--i-recorded-this"');
    expect(stampCache({ file, model: MODEL, producer: P })).toEqual({ stamped: 0, already: 2 });
  });

  it("works on a gzipped committed layer", () => {
    const root = tmp(), file = join(root, ".eval-cache", "c.jsonl.gz");
    writeFileSync(file, gzipSync([header(), legacy("a")].join("\n") + "\n"));
    expect(stampCache({ file, model: MODEL, producer: P }).stamped).toBe(1);
    expect(gunzipSync(readFileSync(file)).toString()).toContain('"m":"@cf/baai/bge-small-en-v1.5"');
  });

  it("refuses when it cannot narrow the claim: wrong model, no or several producer records, a different producer, a live writer", () => {
    const root = tmp(), dir = join(root, ".eval-cache");
    const t = (name: string, body: string) => { writeFileSync(join(dir, name), body); return join(dir, name); };
    expect(() => stampCache({ file: t("a", [header("@cf/baai/bge-m3"), legacy("a")].join("\n")), model: MODEL, producer: P })).toThrow(/not @cf\/baai\/bge-small/);
    expect(() => stampCache({ file: t("b", legacy("a")), model: MODEL, producer: P })).toThrow(/0 producer records/);
    expect(() => stampCache({ file: t("c", [header(), header("@cf/baai/bge-m3"), legacy("a")].join("\n")), model: MODEL, producer: P })).toThrow(/2 producer records/);
    expect(() => stampCache({ file: t("d", [header(), legacy("a")].join("\n")), model: MODEL, producer: { ...P, revision: "zzz" } })).toThrow(/not the claimed/);
    const live = t("e", [header(), legacy("a")].join("\n"));
    writeFileSync(`${live}.abc.lock`, "{}");
    expect(() => stampCache({ file: live, model: MODEL, producer: P })).toThrow(/lock file/);
    expect(readFileSync(live, "utf8")).not.toContain('"m"'); // refusals leave the file untouched
  });

  it("reads the producer to assert from another cache file", () => {
    const root = tmp(), file = join(root, ".eval-cache", "x.jsonl");
    writeFileSync(file, header() + "\n");
    expect(producerFromCache(file, MODEL)).toEqual(P);
  });
});

describe("stamp-cache command", () => {
  it("parses, and requires the explicit assertion flag", async () => {
    expect(parseCli(["stamp-cache", "--model", MODEL, "--producer-from", "current", "--i-recorded-this"])).toMatchObject({ kind: "stamp-cache", model: MODEL, layer: "local", assertRecorded: true });
    expect(() => parseCli(["stamp-cache", "--model", MODEL])).toThrow(UsageError);
    expect(() => parseCli(["stamp-cache", "--producer-from", "current", "--layer", "committed", "--corpus", "scifact"])).toThrow(UsageError);
    const err = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect(await main(["stamp-cache", "--model", MODEL, "--producer-from", "current"])).toBe(2); } finally { err.mockRestore(); }
  });
});
