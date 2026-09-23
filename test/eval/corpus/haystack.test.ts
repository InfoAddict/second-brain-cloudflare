import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COMMON_TOKENS, DENSE_TOKENS, generateHaystack, type HaystackOptions } from "./haystack";
import { readScopeWorkspaces } from "../../../src/lib/scope";
import { ACTORS, DAY_MS, EVAL_NOW, IDENTITIES, WORKSPACES, needleToEntry } from "./types";

const base: HaystackOptions = {
  count: 256,
  seed: 7,
  commonRate: 0.18,
  idPrefix: "f",
  now: EVAL_NOW,
  spanDays: 730,
  cjkRate: 0.08,
  longRate: 0.02,
  workspaces: [
    { workspaceId: WORKSPACES.avery, actorId: ACTORS.avery, weight: 45 },
    { workspaceId: WORKSPACES.company, actorId: ACTORS.blake, weight: 45 },
    { workspaceId: WORKSPACES.blake, actorId: ACTORS.blake, weight: 10 },
  ],
};

// The real corpus parameters (plan 6c CORPUS_PARAMS): total, commonRate, seed.
const REAL = [[1000, 0.25, 1001], [5000, 0.25, 5001], [20_000, 0.10, 20_001]] as const;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const df = (rows: { content: string }[], token: string) =>
  rows.filter(row => row.content.toLowerCase().includes(token)).length;
const duplicateShare = (rows: { content: string }[]) => {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.content, (counts.get(row.content) ?? 0) + 1);
  return [...counts.values()].filter(count => count > 1).reduce((sum, count) => sum + count, 0) / rows.length;
};

describe("generateHaystack", () => {
  it("maps an authored needle to the frozen clock and workspace", () => {
    expect(needleToEntry({ id: "n1", content: "Invented note", tags: ["fiction"], workspace: "outsider", ageDays: 2 })).toEqual({
      id: "n1", content: "Invented note", tags: ["fiction"], source: "api",
      createdAt: EVAL_NOW - 2 * DAY_MS, workspaceId: WORKSPACES.outsider, actorId: ACTORS.outsider,
    });
  });

  it("produces byte-identical output for a seed with pinned digests", () => {
    const first = generateHaystack(base);
    const second = generateHaystack(base);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(digest(first)).toBe("360d4bd6a5901acc8b6913da71400ce6c2c1d33fdb8376d2383b00127d0aabba");
    expect(digest(generateHaystack({ ...base, seed: 8 }))).toBe("71d8bd946872ee03203eac027f51d00c199f9cab5969d23c88a982d63bcdcda4");
    expect(first).not.toEqual(generateHaystack({ ...base, seed: 8 }));
  });

  it("produces the same digest under different locale and timezone settings", () => {
    const original = { lang: process.env.LANG, tz: process.env.TZ };
    const expected = digest(generateHaystack(base));
    try {
      process.env.LANG = "ja_JP.UTF-8";
      process.env.TZ = "Asia/Tokyo";
      expect(digest(generateHaystack(base))).toBe(expected);
    } finally {
      if (original.lang === undefined) delete process.env.LANG;
      else process.env.LANG = original.lang;
      if (original.tz === undefined) delete process.env.TZ;
      else process.env.TZ = original.tz;
    }
  });

  it("produces unique ids, bounded timestamps, CJK and multi-chunk notes across workspaces", () => {
    const rows = generateHaystack({ ...base, count: 3000 });
    expect(rows).toHaveLength(3000);
    expect(new Set(rows.map(row => row.id)).size).toBe(3000);
    expect(rows.every(row => row.createdAt <= EVAL_NOW && row.createdAt > EVAL_NOW - 731 * DAY_MS)).toBe(true);
    expect(rows.filter(row => /[぀-ヿ㐀-鿿가-힯]/u.test(row.content)).length).toBeGreaterThan(150);
    expect(rows.filter(row => row.content.length > 1600).length).toBeGreaterThan(30);
    expect(rows.filter(row => row.content.length > 1000).every(row => row.content.length > 1600)).toBe(true);
    expect(rows.filter(row => row.workspaceId === WORKSPACES.avery).length).toBeGreaterThan(1200);
    expect(rows.filter(row => row.workspaceId === WORKSPACES.company).length).toBeGreaterThan(1200);
  });

  it("has no exact-duplicate rows at any scale, for the test and the real corpus parameters", () => {
    const rows = generateHaystack({ ...base, count: 20_000 });
    for (const count of [1000, 5000, 20_000]) expect(duplicateShare(rows.slice(0, count))).toBe(0);
    for (const [count, commonRate, seed] of REAL) expect(duplicateShare(generateHaystack({ ...base, count, commonRate, seed }))).toBe(0);
  });

  it("gives ordinary words realistic document frequency, with many dense tokens beyond the three common ones", () => {
    const rows = generateHaystack({ ...base, count: 5000 });
    const dfs = new Map<string, number>();
    for (const row of rows) for (const word of new Set(row.content.toLowerCase().match(/[a-z]{4,}/g) ?? [])) dfs.set(word, (dfs.get(word) ?? 0) + 1);
    const dense = [...dfs.entries()].filter(([word, count]) => count >= 100 && !(COMMON_TOKENS as readonly string[]).includes(word));
    expect(dense.length).toBeGreaterThanOrEqual(100);
    for (const word of ["thing", "time", "work", "idea", "feel"]) expect(df(rows, word), word).toBeGreaterThan(100);
  });

  it("realizes the requested common rate and exceeds the keyword window in each readable scope", () => {
    const rows = generateHaystack({ ...base, count: 20_000 });
    const pinned = {
      1000: { roadmap: { avery: 168, blake: 154, company: 149 }, standup: { avery: 169, blake: 144, company: 140 }, invoice: { avery: 184, blake: 174, company: 169 } },
      5000: { roadmap: { avery: 862, blake: 783, company: 766 }, standup: { avery: 871, blake: 783, company: 757 }, invoice: { avery: 839, blake: 769, company: 744 } },
      20000: { roadmap: { avery: 3530, blake: 3206, company: 3121 }, standup: { avery: 3452, blake: 3111, company: 3012 }, invoice: { avery: 3376, blake: 3066, company: 2966 } },
    } as const;
    const scopes = {
      avery: readScopeWorkspaces(IDENTITIES.avery, {}),
      blake: readScopeWorkspaces(IDENTITIES.blake, {}),
      company: readScopeWorkspaces(IDENTITIES.blake, { layer: "company" }),
    };
    for (const token of COMMON_TOKENS) {
      const realized = df(rows, token) / rows.length;
      expect(realized).toBeGreaterThan(base.commonRate * 0.75);
      expect(realized).toBeLessThan(base.commonRate * 1.25);
      for (const count of [1000, 5000, 20_000] as const) {
        const prefix = rows.slice(0, count);
        const actual: Record<string, number> = {};
        for (const [viewer, workspaces] of Object.entries(scopes)) {
          const visible = prefix.filter(row => workspaces.includes(row.workspaceId));
          const countDf = df(visible, token);
          actual[viewer] = countDf;
          if (count === 1000) expect(countDf, `${token} ${viewer} at 1k`).toBeLessThan(500);
          else expect(countDf, `${token} ${viewer} at ${count}`).toBeGreaterThan(500);
        }
        expect(actual).toEqual(pinned[count][token]);
      }
    }
  });

  it("keeps every viewer and the company layer past the keyword window at the real corpus parameters (45/45/10 weights)", () => {
    // The 1.9x company boost is what lifts the company layer over 500 at 5k; the real weights and rates are pinned here.
    const pinned = {
      1000: { roadmap: { avery: 237, blake: 211, company: 205 }, standup: { avery: 245, blake: 229, company: 219 }, invoice: { avery: 238, blake: 219, company: 212 } },
      5000: { roadmap: { avery: 1223, blake: 1111, company: 1076 }, standup: { avery: 1186, blake: 1079, company: 1049 }, invoice: { avery: 1206, blake: 1109, company: 1071 } },
      20000: { roadmap: { avery: 1961, blake: 1806, company: 1749 }, standup: { avery: 1965, blake: 1795, company: 1724 }, invoice: { avery: 1916, blake: 1714, company: 1668 } },
    } as const;
    const scopes = {
      avery: readScopeWorkspaces(IDENTITIES.avery, {}),
      blake: readScopeWorkspaces(IDENTITIES.blake, {}),
      company: readScopeWorkspaces(IDENTITIES.blake, { layer: "company" }),
    };
    for (const [count, commonRate, seed] of REAL) {
      const rows = generateHaystack({ ...base, count, commonRate, seed });
      for (const token of COMMON_TOKENS) {
        const actual: Record<string, number> = {};
        for (const [viewer, workspaces] of Object.entries(scopes)) {
          actual[viewer] = df(rows.filter(row => workspaces.includes(row.workspaceId)), token);
          if (count === 1000) expect(actual[viewer], `${token} ${viewer} at 1k`).toBeLessThan(500);
          else expect(actual[viewer], `${token} ${viewer} at ${count}`).toBeGreaterThan(500);
        }
        expect(actual).toEqual(pinned[count][token]);
      }
    }
  });

  it("carries at most two dense-tier words per row and no other word contains one", () => {
    for (const rows of [generateHaystack({ ...base, count: 20_000 }), ...REAL.map(([count, commonRate, seed]) => generateHaystack({ ...base, count, commonRate, seed }))]) {
      const words = new Set<string>();
      for (const row of rows) {
        const text = row.content.toLowerCase();
        expect(DENSE_TOKENS.filter(token => text.includes(token)).length).toBeLessThanOrEqual(2);
        for (const word of text.match(/\p{L}+/gu) ?? []) words.add(word);
      }
      for (const token of DENSE_TOKENS) {
        expect(words.has(token), token).toBe(true);
        expect([...words].filter(word => word !== token && word.includes(token)), token).toEqual([]);
        for (const other of DENSE_TOKENS) if (other !== token) expect(other.includes(token)).toBe(false);
      }
    }
  });

  it("has enough dense words for the common-word category (at least 40 distinct triples)", () => {
    const n = DENSE_TOKENS.length;
    expect((n * (n - 1) * (n - 2)) / 6).toBeGreaterThanOrEqual(40);
  });

  it("keeps each dense word under the keyword window at 1k and over it at 5k and 20k for the default avery and blake scopes", () => {
    // The company-only layer is deliberately not bounded: common-word queries must use the default scope.
    const scopes = [readScopeWorkspaces(IDENTITIES.avery, {}), readScopeWorkspaces(IDENTITIES.blake, {})];
    const configs = [
      ...REAL.map(([count, commonRate, seed]) => ({ rows: generateHaystack({ ...base, count, commonRate, seed }), sizes: [count] })),
      { rows: generateHaystack({ ...base, count: 20_000 }), sizes: [1000, 5000, 20_000] },
    ];
    for (const { rows, sizes } of configs) {
      for (const size of sizes) {
        for (const workspaces of scopes) {
          const visible = rows.slice(0, size).filter(row => workspaces.includes(row.workspaceId));
          for (const token of DENSE_TOKENS) {
            const count = df(visible, token);
            if (size === 1000) expect(count, `${token} at 1k`).toBeLessThan(500);
            else expect(count, `${token} at ${size}`).toBeGreaterThanOrEqual(550);
          }
        }
      }
    }
  });
});
