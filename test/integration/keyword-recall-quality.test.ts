/**
 * Keyword-arm recall quality: the three LIKE-era defects, each pinned by an
 * observable ranking outcome rather than an implementation detail.
 *
 * 1. `ORDER BY created_at DESC LIMIT 100` silently returned the newest 100
 *    candidates, not the best 100 — a strong match older than 100 fresher
 *    substring hits could never enter the candidate set.
 * 2. Substring matching scored "concatenate" as evidence for "cat" at full
 *    weight, so noise outranked genuine word matches of equal recency.
 * 3. Relevance (IDF) was re-estimated from the fetched rows — a sample biased
 *    by recency and capped by the LIMIT — when the corpus-wide frequencies had
 *    already been computed by distillToRareTerms in the same request.
 *
 * Every test forces the dense arm down (VECTORIZE.query rejects) so the
 * keyword arm's ranking is the whole observable result, and seeds equal or
 * controlled created_at so recency decay cannot mask the scoring change.
 */
import { describe, it, expect, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { makeTestEnv, makeTestDb, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { CONFIG_KEY } from "../../src/config";
import { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return { ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext };
}

function seed(db: D1Mock, id: string, content: string, created_at: number) {
  db.entries.push({
    id, content, tags: "[]", source: "api", created_at,
    vector_ids: "[]", recall_count: 0, importance_score: 0,
  });
}

/** Env whose dense arm always fails, isolating the keyword arm. */
function keywordOnlyEnv(db: D1Mock, overrides?: Record<string, unknown>) {
  const kv = makeMemoryKV();
  const env = makeTestEnv(db, {
    OAUTH_KV: kv,
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockRejectedValue(new Error("index unavailable")),
    }),
  });
  const seedConfig = async () => { if (overrides) await kv.put(CONFIG_KEY, JSON.stringify(overrides)); };
  return { env, seedConfig };
}

/**
 * The shared D1Mock deliberately has no handler for distillToRareTerms'
 * frequency aggregate (`SELECT COUNT(*) AS total, SUM(CASE WHEN content LIKE
 * …)`), so distill falls back and fusion sees no corpus stats — which is also
 * what keeps the other 37 mock consumers on their existing behaviour. This
 * wrapper answers that one query from db.entries, locally to this file, so the
 * corpus-IDF path can be exercised end to end.
 */
function answerFrequencyAggregate(db: D1Mock) {
  const orig = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.includes("AS total") && s.includes("SUM(CASE WHEN content LIKE")) {
      return {
        bind: (...args: unknown[]) => ({
          first: async () => {
            const row: Record<string, number> = { total: db.entries.length };
            args
              .map(a => String(a).replace(/^%|%$/g, "").toLowerCase())
              .forEach((p, i) => {
                row[`d${i}`] = db.entries.filter((e: any) => String(e.content).toLowerCase().includes(p)).length;
              });
            return row;
          },
        }),
      };
    }
    return orig(sql);
  };
}

describe("keyword candidate limit", () => {
  it("a word-boundary match buried past the old 100-newest window now wins", async () => {
    const db = makeTestDb();
    // 119 fresher rows that only substring-match "cat"; the one genuine match
    // is seeded last and oldest-in-window, i.e. position 120 by recency —
    // outside the old LIMIT 100 fetch entirely.
    for (let i = 0; i < 119; i++) seed(db, `noise-${i}`, "we concatenate the fields", 1000);
    seed(db, "genuine", "my cat sleeps here", 1000);

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "cat", topK: 3, synthesize: false }, env, ctx);

    expect(res.semanticUnavailable).toBe(true);
    expect(res.matches[0]?.id).toBe("genuine");
    // Re-weighting, not filtering: substring hits still fill the tail.
    expect(res.matches.length).toBe(3);
  });

  it("KEYWORD_CANDIDATE_LIMIT is honoured as a config override", async () => {
    const db = makeTestDb();
    // 50 fresher substring-only rows, then the genuine match older than all of
    // them. An override of 50 (the rule's floor) truncates the fetch window to
    // exactly the noise, so the genuine row cannot appear at all — observable
    // proof the bound limit comes from config, not the shipped constant (100
    // would admit all 52 rows and the genuine row would win the top slot).
    for (let i = 0; i < 50; i++) seed(db, `noise-${i}`, "we concatenate the fields", 1000);
    seed(db, "genuine", "my cat sleeps here", 500);

    const { env, seedConfig } = keywordOnlyEnv(db, { KEYWORD_CANDIDATE_LIMIT: 50 });
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "cat", topK: 10, synthesize: false }, env, ctx);

    expect(res.matches.map(m => m.id)).not.toContain("genuine");
  });
});

describe("substring down-weighting", () => {
  it("a word match outranks a substring match of equal recency, without dropping it", async () => {
    const db = makeTestDb();
    seed(db, "substr", "we concatenate the fields", 1000);
    seed(db, "word", "my cat sleeps here", 1000);

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "cat", topK: 10, synthesize: false }, env, ctx);

    expect(res.matches.map(m => m.id)).toEqual(["word", "substr"]);
  });

  it("identifier-shaped tokens still match on word boundaries", async () => {
    const db = makeTestDb();
    seed(db, "issue", "see issue #149 for the fix", 1000);
    seed(db, "noise", "phone number 5551490000 on file", 1000);

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "#149", topK: 10, synthesize: false }, env, ctx);

    expect(res.matches[0]?.id).toBe("issue");
  });

  it("SUBSTRING_MATCH_WEIGHT: 1 restores the old parity, proving the knob threads", async () => {
    const db = makeTestDb();
    // The substring row is fresher; at equal weight the tie breaks on recency
    // and the noise wins again — exactly the pre-change behaviour.
    seed(db, "substr", "we concatenate the fields", 2000);
    seed(db, "word", "my cat sleeps here", 1000);

    const { env, seedConfig } = keywordOnlyEnv(db, { SUBSTRING_MATCH_WEIGHT: 1 });
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "cat", topK: 10, synthesize: false }, env, ctx);

    expect(res.matches[0]?.id).toBe("substr");
  });
});

describe("corpus-wide IDF", () => {
  it("ranks by corpus rarity even when the fetched sample says the opposite", async () => {
    const db = makeTestDb();
    // The fetch window is pinned to 100 rows (config override — also what the
    // pre-config constant shipped), and the corpus is arranged so the window
    // disagrees with the truth. In the window: alpha appears twice, beta 8
    // times, gamma 90 times → a window-sample IDF calls alpha the rare term.
    // In the corpus: alpha is in 120 rows, beta in 8, gamma in 90 → beta is
    // the rare term. Only corpus-wide IDF ranks the beta row first.
    seed(db, "alpha-hit", "alpha memo", 1000);
    seed(db, "alpha-hit-2", "alpha note", 999);
    for (let i = 0; i < 8; i++) seed(db, `beta-${i}`, "beta report", 990 - i);
    for (let i = 0; i < 90; i++) seed(db, `gamma-${i}`, "gamma worklog", 500 - i);
    // Older than the 100-row window: the alpha bulk the sample never sees.
    for (let i = 0; i < 118; i++) seed(db, `alpha-old-${i}`, "alpha archive", 100 - (i % 90));
    // Filler keeps alpha under the 30% saturation cut so distill retains all terms.
    for (let i = 0; i < 190; i++) seed(db, `filler-${i}`, "unrelated filler", 10);
    answerFrequencyAggregate(db);

    const { env, seedConfig } = keywordOnlyEnv(db, { KEYWORD_CANDIDATE_LIMIT: 100 });
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "alpha beta gamma", topK: 5, synthesize: false }, env, ctx);

    // Corpus IDF: idf(beta) = log(1+408/9) ≈ 3.8 ≫ idf(alpha) = log(1+408/121)
    // ≈ 1.5 — the beta row must lead. Window-sample IDF inverts it: df(alpha)=2
    // in 100 rows → log(1+100/3) ≈ 3.5 ≫ df(beta)=8 → log(1+100/9) ≈ 2.5,
    // which puts alpha-hit first. matches[0] is the whole verdict.
    expect(res.matches[0]?.id).toBe("beta-0");
  });

  it("without corpus stats, fusion still ranks (sample fallback)", async () => {
    const db = makeTestDb();
    seed(db, "common-hit", "alpha memo", 1000);
    seed(db, "rare-hit", "beta report", 1000);
    seed(db, "alpha-2", "alpha note", 999);
    seed(db, "alpha-3", "alpha list", 998);
    // No answerFrequencyAggregate → distill falls back, df/total are null.

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "alpha beta", topK: 5, synthesize: false }, env, ctx);

    // Sample IDF over the 4 fetched rows: beta (df 1) beats alpha (df 3).
    expect(res.matches[0]?.id).toBe("rare-hit");
    expect(res.matches.length).toBe(4);
  });
});
