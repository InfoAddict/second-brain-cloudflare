import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import { ReplayStore, makeReplayAi } from "./ai-replay";
import { buildCorpus, CORE_DATA_DIR } from "./corpus/build";
import { loadCorpus } from "./corpus/loader";
import { replayPaths } from "./corpora";
import { compareToLock } from "./lock";
import { runVariant } from "./runner";
import type { VariantReport } from "./types";
import { getVariant } from "./variants";

const MODEL = DEFAULTS.EMBEDDING_MODEL;
const LOCK = resolve(CORE_DATA_DIR, "../baselines", `core-1k.${MODEL.split("/").pop()}.json`);
const cache = replayPaths(MODEL, "core-1k").read;

// No skipIf: on a checkout missing the lock or the committed cache this must fail loudly, not pass by skipping.
describe("baseline lock (recall tripwire)", () => {
  it("the committed lock and replay layer are present", () => {
    expect(existsSync(LOCK), `${LOCK} missing: run npm run eval:recall -- lock and commit it`).toBe(true);
    expect(cache.length, "no replay cache: Task 9 Step 12 must be committed").toBeGreaterThan(0);
  });

  it("recall on core-1k still ranks every golden query exactly as the committed lock does", async () => {
    const lock = JSON.parse(readFileSync(LOCK, "utf8")) as VariantReport;
    const spec = buildCorpus("core-1k");
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore(cache), mode: "replay" }), embeddingModel: MODEL });
    try {
      const fresh = await runVariant({ corpus, variant: getVariant("baseline"), queries: spec.queries, isolate: "warm", embeddingModel: MODEL });
      const diff = compareToLock(lock, fresh);
      const how = "If intended, run: npm run eval:recall -- --compare baseline,<variant> with evidence, then npm run eval:recall -- lock (add --accept-data-change \"<reason>\" if golden data changed), and commit the new lock with the gate output in the message.";
      expect(diff.fingerprintMismatch, `the golden data differs from the data the lock was recorded on. ${how}`).toBe(false);
      expect(diff.missing, `queries in the lock but not in the golden set now. ${how}`).toEqual([]);
      expect(diff.extra, `queries in the golden set but not in the lock. ${how}`).toEqual([]);
      expect(diff.changed, `recall ranking changed for ${diff.changed.length} golden queries (first: ${diff.changed.slice(0, 5).join(", ")}). ${how}`).toEqual([]);
    } finally {
      await corpus.close();
    }
  }, 300_000);
});
