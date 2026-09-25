/**
 * Ids first, text last: the keyword arm's rows carry no note text, only how each term sits in the note (src/recall/keyword-rows.ts).
 * The levels must be what the Worker used to compute by scanning the text, on both routes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { keywordSearch } from "../../src/recall/search";
import { mulberry32 } from "../eval/stats";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

let sqlite: SqliteD1;
afterEach(() => sqlite?.close());

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** What fusion used to compute over the whole text: 0 absent, 1 only inside longer words, 2 at a word boundary. */
function reference(content: string, term: string): 0 | 1 | 2 {
  const lc = content.toLowerCase(), needle = term.toLowerCase();
  if (!lc.includes(needle)) return 0;
  return new RegExp(`(?<![\\w])${escapeRegExp(needle)}(?![\\w])`).test(lc) ? 2 : 1;
}

async function boot(ftsReady: boolean): Promise<Env> {
  resetDatabaseInit(); resetFtsReadyMemo();
  sqlite = makeSqliteD1();
  const kv = makeMemoryKV();
  const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: kv }) as Env;
  await initializeDatabase(env);
  if (ftsReady) await kv.put(FTS_READY_KV_KEY, "1");
  resetFtsReadyMemo();
  return env;
}

const TERMS = ["cat", "v1.9", "#149", "kv7", "Zorvane"];
const VOCAB = ["the", "quiet", "harbour", "morning", "ledger", "walked", "slowly", "around", "market", "again", "plan", "notes"];
const AROUND = ["", " ", "x", "_", "-", ".", "(", ")", "9", "\n", "é"];

/** Notes with each term 0-2 times, glued to random neighbours, so every level shows up. At most two occurrences keeps the notes inside what the SQL decides exactly. */
function notes(seed: number, n: number) {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  return Array.from({ length: n }, (_, i) => {
    const parts = Array.from({ length: 6 + Math.floor(rand() * 8) }, () => pick(VOCAB));
    for (const t of TERMS) {
      const times = Math.floor(rand() * 3);
      for (let k = 0; k < times; k++) parts.splice(Math.floor(rand() * parts.length), 0, `${pick(AROUND)}${rand() < 0.5 ? t : t.toUpperCase()}${pick(AROUND)}`);
    }
    return { id: `n${i}`, content: parts.join(" ") };
  });
}

describe("keyword rows are ids first, text last", () => {
  for (const ftsReady of [false, true]) {
    it(`carry per-term levels equal to a scan of the text, and no text (${ftsReady ? "FTS" : "LIKE"} route)`, async () => {
      const env = await boot(ftsReady);
      const corpus = notes(7, 120);
      corpus.forEach((n, i) => sqlite.seed({ id: n.id, content: n.content, createdAt: 1000 + i }));
      const byId = new Map(corpus.map(n => [n.id, n.content]));
      const { rows, route } = await keywordSearch(TERMS.map(t => t.toLowerCase()), env, 500);
      expect(route).toMatch(ftsReady ? /^fts/ : /^like/);
      expect(rows.length).toBeGreaterThan(50);
      let boundary = 0, inside = 0;
      for (const row of rows) {
        expect(row.content).toBeUndefined();
        for (const t of TERMS.map(x => x.toLowerCase())) {
          const want = reference(byId.get(row.id)!, t);
          expect(row.hits!.get(t), `${row.id} / ${t}: ${JSON.stringify(byId.get(row.id))}`).toBe(want);
          if (want === 2) boundary++; else if (want === 1) inside++;
        }
      }
      expect(boundary).toBeGreaterThan(20); // the corpus really exercises both levels
      expect(inside).toBeGreaterThan(20);
    });
  }

  it("returns a small row for a huge note", async () => {
    const env = await boot(true);
    sqlite.seed({ id: "big", content: `${"filler words ".repeat(5000)} needle ${"more filler ".repeat(5000)}`, createdAt: 1 });
    const { rows } = await keywordSearch(["needle"], env, 500);
    expect(JSON.stringify(rows).length).toBeLessThan(500);
    expect(rows[0].hits!.get("needle")).toBe(2);
  });

  it("finds a full-width term, which SQLite does not fold", async () => {
    const env = await boot(false);
    sqlite.seed({ id: "wide", content: "Ｚｏｒｖａｎｅ 123 was here", createdAt: 1 });
    const { rows } = await keywordSearch(["Ｚｏｒｖａｎｅ"], env, 500);
    expect(rows.map(r => r.id)).toEqual(["wide"]);
    expect(rows[0].hits!.get("Ｚｏｒｖａｎｅ")).toBeGreaterThan(0);
  });

  // LIKE folds ASCII case only, so it never proposed an upper-case non-ASCII note; the FTS route does, and the levels must agree with the scan
  const FOLDS: [string, string, string][] = [
    ["accented capitals", "CAFÉ au lait", "café"],
    ["capitalised accent", "Café au lait", "café"],
    ["accented capitals inside a word", "CAFÉS au lait", "café"],
    ["Greek capitals", "ΑΘΗΝΑ ΕΛΛΑΔΑ", "αθηνα"],
    ["Greek capitals, accented", "ΆΘΗΝΑ ΕΛΛΑΔΑ", "άθηνα"],
    ["Cyrillic capitals", "МОСКВА и Питер", "москва"],
    ["Cyrillic title case", "Москва и Питер", "москва"],
    ["typed upper, note lower", "café au lait", "CAFÉ"],
    ["second occurrence in another case", "xCAFÉ CAFÉ", "café"],
    ["second occurrence, first inside a word", "cafés and CAFÉ", "café"],
    ["mixed case inside the word", "cAFÉ au lait", "café"],
    ["mixed case, inside a longer word", "xcAFÉ au lait", "café"],
    ["mixed case second occurrence", "xcafé cAFÉ", "café"],
  ];
  for (const [name, content, term] of FOLDS) {
    it(`folds non-ASCII case as the text scan did: ${name} (FTS route)`, async () => {
      const env = await boot(true);
      sqlite.seed({ id: "n", content, createdAt: 1 });
      const { rows } = await keywordSearch([term], env, 500);
      expect(rows.map(r => r.id)).toEqual(["n"]);
      expect(rows[0].hits!.get(term)).toBe(reference(content, term));
    });
  }

  // A level of 2 found through an UPPERCASE form is not what the old scan found: it lowercased the note, and these do not round-trip
  const NO_ROUNDTRIP: [string, string, string][] = [
    ["sharp s against SS", "anchor SS", "ß"],
    ["fi ligature against FI", "anchor FI", "ﬁ"],
    ["sigma against a capital sigma", "anchor ΟΣ", "σ"],
    ["final sigma against a capital sigma", "anchor ΟΣΑ", "ς"],
    ["sigma against the word it ends", "anchor ΑΣΑ", "σ"],
  ];
  for (const [name, content, term] of NO_ROUNDTRIP) {
    it(`does not read a level the text scan would not: ${name} (FTS route)`, async () => {
      const env = await boot(true);
      sqlite.seed({ id: "n", content, createdAt: 1 });
      const { rows } = await keywordSearch(["anchor", term], env, 500);
      expect(rows.map(r => r.id)).toEqual(["n"]);
      expect(rows[0].hits!.get(term)).toBe(reference(content, term));
    });
  }

  it("settles a mixed-script note term by term", async () => {
    const env = await boot(true);
    const content = "Москва is not CAFÉ, and xΑΘΗΝΑ ΑΘΗΝΑ stays; cAFÉ too";
    sqlite.seed({ id: "n", content, createdAt: 1 });
    const terms = ["москва", "café", "αθηνα", "athens"];
    const { rows } = await keywordSearch(terms, env, 500);
    expect(rows.map(r => r.id)).toEqual(["n"]);
    for (const t of terms) expect(rows[0].hits!.get(t)).toBe(reference(content, t));
    expect(rows[0].hits!.get("αθηνα")).toBe(2);
  });

  it("reads note text only for a non-ASCII term, and only for the rows still undecided", async () => {
    const env = await boot(true);
    sqlite.seed({ id: "decided", content: "café society", createdAt: 1 });
    sqlite.seed({ id: "open", content: "xCAFÉ CAFÉ", createdAt: 2 });
    sqlite.seed({ id: "none", content: "tea only, cafeteria", createdAt: 3 });
    const sqls: string[] = [];
    const prepare = env.DB.prepare.bind(env.DB);
    (env.DB as { prepare: unknown }).prepare = (sql: string) => { sqls.push(sql); return prepare(sql); };
    await keywordSearch(["cat", "tea"], env, 500);
    expect(sqls.filter(s => /^SELECT id, content FROM entries/.test(s))).toEqual([]);
    sqls.length = 0;
    const { rows } = await keywordSearch(["café"], env, 500);
    const reads = sqls.filter(s => /^SELECT id, content FROM entries WHERE id IN/.test(s));
    expect(reads.length).toBeLessThanOrEqual(1);
    for (const r of rows) expect(r.hits!.get("café")).toBe(reference({ decided: "café society", open: "xCAFÉ CAFÉ", none: "tea only, cafeteria" }[r.id]!, "café"));
    expect(rows.find(r => r.id === "open")!.hits!.get("café")).toBe(2);
  });

  it("decides on the first two occurrences of a term: a boundary occurrence only after two inside-word ones reads as inside", async () => {
    const env = await boot(false);
    sqlite.seed({ id: "late", content: "concat concats and finally cat", createdAt: 1 });
    const { rows } = await keywordSearch(["cat"], env, 500);
    expect(reference("concat concats and finally cat", "cat")).toBe(2);
    expect(rows[0].hits!.get("cat")).toBe(1);
  });

  it("binds each term once, so sixteen terms and a scope stay far under D1's 100 bound values", async () => {
    const env = await boot(false);
    sqlite.seed({ id: "a", content: "alpha", createdAt: 1 });
    const terms = Array.from({ length: 16 }, (_, i) => (i === 0 ? "alpha" : `term${i}`));
    const issued: unknown[][] = [];
    const db = env.DB as any;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => { const st = prepare(sql); const bind = st.bind.bind(st); st.bind = (...b: unknown[]) => { issued.push(b); return bind(...b); }; return st; };
    await keywordSearch(terms, env, 500, {}, { userId: "u", role: "member", personalWorkspaceId: "p", companyWorkspaceIds: ["c1", "c2"], defaultShare: "" as const });
    const max = Math.max(...issued.map(b => b.length));
    expect(max).toBeGreaterThan(30);
    expect(max).toBeLessThan(60);
  });
});
