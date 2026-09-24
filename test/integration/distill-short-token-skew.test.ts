/**
 * T-0074: a too-short token cannot be counted through the index, so its df is
 * sampled from the newest rows. On a corpus whose recent rows differ from the
 * rest that sample is wrong in either direction; whichever way it errs, it must
 * never cost the query a counted term in the rebuilt (embedded) query.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { distillToRareTerms } from "../../src/recall/distill";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import type { Env } from "../../src/env";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const ROWS = 3000;
const NEWEST = 200;

let sqlite: SqliteD1;
let env: Env;

/** Row i is created at i + 1, so the newest NEWEST rows are i >= ROWS - NEWEST. */
function seedCorpus(hasIo: (i: number) => boolean) {
  for (let i = 0; i < ROWS; i++) {
    const words = [`note${i}`, hasIo(i) ? "io" : ""];
    if (i < 10) words.push("throughput");
    if (i >= 10 && i < 70) words.push("latency");
    if (i >= 70 && i < 190) words.push("queue");
    sqlite.seed({ id: `row-${i}`, content: words.filter(Boolean).join(" "), createdAt: i + 1 });
  }
}

const kept = (query: string) => new Set(query.split(/\s+/));

beforeEach(async () => {
  resetDatabaseInit();
  resetFtsReadyMemo();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
  resetFtsReadyMemo();
});

describe("short-token df sample under recency skew", () => {
  it("keeps every counted term when io is common overall but absent from the newest rows (sample reads it as rare)", async () => {
    // true df of io = 80% of the corpus; the sample sees none of it
    seedCorpus(i => i < ROWS * 0.8);
    const out = await distillToRareTerms("io throughput latency queue", env);
    expect(out.distillSource).toBe("fts");
    expect(out.df!.get("io")!, "the sample under-reads io").toBeLessThan(60);
    expect(kept(out.query)).toEqual(new Set(["throughput", "latency", "queue"]));
  });

  it("keeps every counted term when io is specific but fills the newest rows (sample reads it as saturated)", async () => {
    // true df of io = 240 rows (8%), all of them the newest
    seedCorpus(i => i >= ROWS - 240);
    const out = await distillToRareTerms("io throughput latency queue", env);
    expect(out.df!.get("io")!, "the sample over-reads io").toBeGreaterThan(ROWS * 0.3);
    expect(kept(out.query)).toEqual(new Set(["throughput", "latency", "queue"]));
  });

  it("still spends a free slot on a short token the sample finds unsaturated", async () => {
    seedCorpus(i => i < ROWS * 0.8);
    const out = await distillToRareTerms("io throughput", env);
    expect(kept(out.query)).toEqual(new Set(["io", "throughput"]));
  });
});
