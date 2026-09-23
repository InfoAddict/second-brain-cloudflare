/**
 * T-0059 equivalence proof: distillToRareTerms's df/total must be the same
 * whether they come from the FTS index or the LIKE full scan it replaces,
 * for every term the FTS count path actually serves (an "unsafe" term, per
 * ftsCountSafeToken, routes the WHOLE query to LIKE instead — see
 * test/unit/recall-fts-query.test.ts for the raw divergence that guard
 * exists to route around).
 *
 * Real SQLite (test/helpers/sqlite-d1.ts), because the thing under test is
 * whether FTS5 trigram MATCH counts agree with LIKE counts — unevaluable by
 * the string-matching D1 mock.
 */
import { describe, it, expect } from "vitest";
import { distillToRareTerms, resetDistillTotalCache } from "../../src/recall/distill";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { FTS_READY_KV_KEY, QUERY_SATURATION_FRACTION } from "../../src/constants";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";

/** Deterministic PRNG (mulberry32), so a failing trial is reproducible from its seed. */
function mulberry32(seed: number) {
  return function random() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Category pools mixed within a single trial's corpus, spanning every shape
// the task calls out: ASCII, mixed case, non-ASCII case (unsafe for FTS
// counting — ftsCountSafeToken routes these to LIKE), CJK, identifiers,
// substrings inside longer words, and embedded quotes.
const ASCII = ["ledger", "atlas", "widget", "gadget", "dashboard", "runtime", "invoice", "printer", "harbor", "cactus", "budget", "report", "kernel", "socket", "canvas", "meadow", "quartz", "cobalt", "lumen", "forge"];
const MIXED_CASE = ["Dashboard", "REPORT", "Runtime", "GADGET", "Ledger", "Atlas"];
const ACCENTED = ["café", "résumé", "naïve", "Zürich", "façade", "Nürnberg"];
const CJK = ["認証方式", "東京都庁", "予算確定", "契約書署名", "歯医者予約", "図書館返却"];
const IDENTIFIERS = ["#149", "v1.9", "item-42", "order#7", "build-2024", "ticket-88"];
const QUOTED = [`ro"bot`, `en"try`, `it"self`, `"quoted`];
const SUBSTRING_HOSTS = (w: string) => [`pre${w}fix`, `${w}s`, `co${w}nate`];

const POOLS: { name: string; words: string[] }[] = [
  { name: "ascii", words: ASCII },
  { name: "mixed-case", words: [...ASCII, ...MIXED_CASE] },
  { name: "accented", words: [...ASCII, ...ACCENTED] },
  { name: "cjk", words: [...ASCII, ...CJK] },
  { name: "identifiers", words: [...ASCII, ...IDENTIFIERS] },
  { name: "quoted", words: [...ASCII, ...QUOTED] },
  { name: "mixed-everything", words: [...ASCII, ...MIXED_CASE, ...ACCENTED, ...CJK, ...IDENTIFIERS, ...QUOTED] },
];

function sampleDistinct(rng: () => number, pool: string[], n: number): string[] {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

interface Trial { rows: string[]; query: string; poolName: string }

function buildTrial(rng: () => number): Trial {
  const pool = POOLS[Math.floor(rng() * POOLS.length)];
  const queryWordCount = 2 + Math.floor(rng() * 3); // 2-4 distinct query words
  const queryWords = sampleDistinct(rng, pool.words, queryWordCount);
  const rowCount = 10 + Math.floor(rng() * 40); // well under any saturation cap
  const rows: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const wordsInRow: string[] = [];
    for (const w of queryWords) {
      const r = rng();
      if (r < 0.15) wordsInRow.push(...SUBSTRING_HOSTS(w).slice(0, 1)); // buried inside a longer word only
      else if (r < 0.55) wordsInRow.push(w); // a genuine standalone match
      // else: this row skips the term entirely, varying its df
    }
    const fillerCount = 1 + Math.floor(rng() * 3);
    for (let f = 0; f < fillerCount; f++) wordsInRow.push(pool.words[Math.floor(rng() * pool.words.length)]);
    rows.push(wordsInRow.length ? wordsInRow.join(" ") : "filler row text");
  }
  return { rows, query: queryWords.join(" "), poolName: pool.name };
}

async function distillBoth(trial: Trial) {
  const sqlite = makeSqliteD1();
  resetDatabaseInit();
  const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  trial.rows.forEach((content, i) => sqlite.seed({ id: `row-${i}`, content, createdAt: i + 1 }));

  resetFtsReadyMemo();
  resetDistillTotalCache();
  const likeOut = await distillToRareTerms(trial.query, env);

  await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
  resetFtsReadyMemo();
  resetDistillTotalCache();
  const ftsOut = await distillToRareTerms(trial.query, env);

  sqlite.close();
  return { likeOut, ftsOut };
}

describe("T-0059 equivalence: FTS-counted distillation vs the LIKE scan it replaces", () => {
  const TRIALS = 320;
  const seedBase = 20260923;

  it(`agrees on kept terms and the rebuilt query across ${TRIALS} randomized corpora`, async () => {
    const divergences: string[] = [];
    let ftsRunCount = 0;
    let likeFallbackCount = 0;

    for (let n = 0; n < TRIALS; n++) {
      const rng = mulberry32(seedBase + n);
      const trial = buildTrial(rng);
      const { likeOut, ftsOut } = await distillBoth(trial);

      const label = `trial#${n} seed=${seedBase + n} pool=${trial.poolName} query=${JSON.stringify(trial.query)}`;

      if (ftsOut.query !== likeOut.query) {
        divergences.push(`${label}: rebuilt query differs — like=${JSON.stringify(likeOut.query)} fts=${JSON.stringify(ftsOut.query)}`);
        continue;
      }

      if (ftsOut.distillSource === "fts") {
        ftsRunCount++;
        expect(likeOut.distillSource === "like" || likeOut.distillSource === "shortcut", label).toBe(true);
        if (ftsOut.total !== likeOut.total) {
          divergences.push(`${label}: total differs — like=${likeOut.total} fts=${ftsOut.total}`);
          continue;
        }
        if (ftsOut.df && likeOut.df) {
          for (const [term, ftsDf] of ftsOut.df) {
            const likeDf = likeOut.df.get(term);
            // Every term in this generator's corpora sits far under the
            // saturation cap (rows stay in the tens; the cap floors at
            // FTS_MATCH_BUDGET+1 = 2001), so every term here is UNCAPPED —
            // this branch is exactly the equivalence bar the task requires.
            if (ftsDf !== likeDf) {
              divergences.push(`${label}: df("${term}") differs — like=${likeDf} fts=${ftsDf}`);
            }
          }
        }
      } else {
        likeFallbackCount++;
      }
    }

    expect(divergences, divergences.slice(0, 10).join("\n")).toEqual([]);
    // Sanity: the generator must actually exercise both paths, or this test
    // proves nothing. "accented" trials are expected to fall back to LIKE
    // (ftsCountSafeToken), so likeFallbackCount > 0 is expected too.
    expect(ftsRunCount).toBeGreaterThan(TRIALS / 4);
    expect(likeFallbackCount).toBeGreaterThan(0);
  });
});

describe("T-0059 cost: the FTS count path never scans entries or entries_fts in full", () => {
  it("EXPLAIN QUERY PLAN shows entries_fts searched by MATCH and entries joined by rowid", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    resetDistillTotalCache();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
    for (let i = 0; i < 30; i++) sqlite.seed({ id: `row-${i}`, content: "atlas ledger widget filler text", createdAt: i + 1 });
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();

    const out = await distillToRareTerms("atlas ledger widget", env);
    expect(out.distillSource).toBe("fts");

    // The cold path issues two batches: [liveness, total] then the per-term
    // counts. Find the count batch (every statement mentions entries_fts).
    const countBatch = sqlite.batches.find(b => b.every(sql => sql.includes("entries_fts")) && b.some(sql => sql.includes("MATCH")));
    expect(countBatch, JSON.stringify(sqlite.batches, null, 2)).toBeTruthy();

    for (const sql of countBatch!) {
      const { results } = await sqlite.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(`"atlas"`, 100).all();
      const detail = (results as { detail: string }[]).map(r => r.detail).join(" | ");
      // SQLite always labels virtual-table access "SCAN <table> VIRTUAL TABLE
      // INDEX n:xx" in EXPLAIN QUERY PLAN, even when it is using an index —
      // "SCAN" here is the fixed vocabulary for any xFilter-driven virtual
      // table walk, not evidence of a full scan. The "M" index code is FTS5's
      // own marker for "driven by a MATCH constraint" (bestIndex idxStr);
      // real rows_read for this path was already measured flat with corpus
      // growth in E2E (docs/superpowers/plans/2026-09-21-fts5-lexical-arm.md).
      expect(detail, detail).toMatch(/entries_fts VIRTUAL TABLE INDEX \d+:M/);
      // entries (aliased e) must be reached by its primary-key/rowid index,
      // never a bare table scan.
      expect(detail, detail).toMatch(/SEARCH e USING/);
      expect(detail, detail).not.toMatch(/\bSCAN e\b/);
    }
    sqlite.close();
  });
});

const memberOf = (personal: string): Identity => ({
  userId: "u1",
  role: "member",
  personalWorkspaceId: personal,
  companyWorkspaceIds: [],
  defaultShare: "" as const,
});

function seedIn(sqlite: SqliteD1, id: string, workspaceId: string, content: string, createdAt: number) {
  sqlite.seed({ id, content, createdAt });
  sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
}

describe("T-0059 scope: the FTS count path never counts another workspace's rows", () => {
  it("a foreign workspace's matching rows do not inflate df or total", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    resetDistillTotalCache();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);

    const identity = memberOf("ws-a");
    seedIn(sqlite, "mine-1", "ws-a", "atlas ledger quartz", 1);
    seedIn(sqlite, "mine-2", "ws-a", "atlas filler text", 2);
    // A foreign workspace with the SAME terms: if the scope clause were
    // dropped, these would inflate both df and total for ws-a's caller.
    for (let i = 0; i < 20; i++) seedIn(sqlite, `foreign-${i}`, "ws-b", "atlas ledger quartz", 10 + i);

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const out = await distillToRareTerms("atlas ledger quartz", env, undefined, {}, identity);

    expect(out.distillSource).toBe("fts");
    expect(out.total).toBe(2); // ws-a's two rows only
    expect(out.df!.get("atlas")).toBe(2);
    expect(out.df!.get("ledger")).toBe(1);
    sqlite.close();
  });
});

describe("T-0059 liveness: a stale index (ready flag set, triggers gone) falls back to LIKE", () => {
  it("falls back to the LIKE scan when a sync trigger is missing despite fts:ready", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    resetDistillTotalCache();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
    for (let i = 0; i < 10; i++) sqlite.seed({ id: `row-${i}`, content: "atlas ledger widget", createdAt: i + 1 });

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    // A hot-path repair can drop a trigger without ever clearing KV — the
    // exact drift write-path isolation v2.2 defends against.
    sqlite.db.prepare(`DROP TRIGGER entries_fts_delete`).run();

    const out = await distillToRareTerms("atlas ledger widget", env);
    expect(out.distillSource).toBe("like");
    expect(out.total).toBe(10);
    sqlite.close();
  });
});

describe("T-0059 total cache: a time-bounded call never poisons the unbounded scoped total", () => {
  it("an unbounded call after a bounded one still sees the whole corpus", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    resetDistillTotalCache();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
    for (let i = 0; i < 5; i++) sqlite.seed({ id: `old-${i}`, content: "atlas ledger widget", createdAt: 1 + i });
    for (let i = 0; i < 5; i++) sqlite.seed({ id: `new-${i}`, content: "atlas ledger widget", createdAt: 100 + i });

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();

    const bounded = await distillToRareTerms("atlas ledger widget", env, undefined, { after: 50 });
    expect(bounded.distillSource).toBe("fts");
    expect(bounded.total).toBe(5); // only the 5 rows created after t=50

    const unbounded = await distillToRareTerms("atlas ledger widget", env);
    expect(unbounded.distillSource).toBe("fts");
    expect(unbounded.total).toBe(10); // the whole corpus, not the bounded call's leftover total
    sqlite.close();
  });
});

describe("T-0059 ranking effect: a saturated (capped) term still gets dropped, same as the true count would", () => {
  it("caps a near-universal term's df but keeps the same keep/drop outcome as LIKE", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    resetDistillTotalCache();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);

    // 8,000 rows: large enough that 30% of the corpus (the saturation cap)
    // exceeds FTS_MATCH_BUDGET (2,000), so the "common" term's FTS count is
    // genuinely capped rather than exact. "rare" appears in only 5 rows.
    const total = 8000;
    for (let i = 0; i < total; i++) {
      const content = i < total - 5 ? "common filler word" : "common rare word";
      sqlite.seed({ id: `row-${i}`, content, createdAt: i + 1 });
    }

    resetFtsReadyMemo();
    resetDistillTotalCache();
    const likeOut = await distillToRareTerms("common rare", env);

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    resetDistillTotalCache();
    const ftsOut = await distillToRareTerms("common rare", env);

    expect(ftsOut.distillSource).toBe("fts");
    const trueCommonDf = likeOut.df!.get("common")!;
    const cappedCommonDf = ftsOut.df!.get("common")!;
    expect(trueCommonDf).toBe(total); // every row contains "common"
    expect(cappedCommonDf).toBeLessThan(trueCommonDf); // genuinely capped, not coincidentally equal
    expect(cappedCommonDf).toBeGreaterThan(QUERY_SATURATION_FRACTION * total); // still unambiguously over the saturation line

    // The numeric df differs (capped vs true — the one documented semantic
    // difference), but the RANKING OUTCOME is identical: "common" is dropped
    // and "rare" is kept, by both methods, since both counts land the same
    // side of the saturation boundary.
    expect(likeOut.query).toBe("rare");
    expect(ftsOut.query).toBe("rare");
    expect(ftsOut.query).toBe(likeOut.query);

    sqlite.close();
  });
});
