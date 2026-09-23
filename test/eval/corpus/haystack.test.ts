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
    { workspaceId: WORKSPACES.avery, actorId: ACTORS.avery, weight: 55 },
    { workspaceId: WORKSPACES.company, actorId: ACTORS.blake, weight: 35 },
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
    expect(digest(first)).toBe("f2608e792912355c14ba9649627b97890ffd16e65e09b05b8d222e8600dfe07c");
    expect(digest(generateHaystack({ ...base, seed: 8 }))).toBe("ffe6fa575e1b5d410956b75182ff645e0b67d6367307d0c26d166e27be97d4d5");
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
    expect(rows.filter(row => row.workspaceId === WORKSPACES.avery).length).toBeGreaterThan(1500);
    expect(rows.filter(row => row.workspaceId === WORKSPACES.company).length).toBeGreaterThan(900);
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
      1000: { roadmap: { avery: 159, blake: 134, company: 119 }, standup: { avery: 174, blake: 131, company: 120 }, invoice: { avery: 173, blake: 142, company: 130 } },
      5000: { roadmap: { avery: 834, blake: 626, company: 576 }, standup: { avery: 844, blake: 620, company: 570 }, invoice: { avery: 814, blake: 607, company: 561 } },
      20000: { roadmap: { avery: 3459, blake: 2620, company: 2415 }, standup: { avery: 3435, blake: 2589, company: 2391 }, invoice: { avery: 3362, blake: 2507, company: 2325 } },
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

  it("keeps every viewer and the company layer past the keyword window at the real corpus parameters (55/35/10 weights)", () => {
    // The 1.9x company boost is what lifts the company layer over 500 at 5k; the real weights and rates are pinned here.
    const pinned = {
      1000: { roadmap: { avery: 243, blake: 186, company: 173 }, standup: { avery: 240, blake: 173, company: 163 }, invoice: { avery: 233, blake: 185, company: 170 } },
      5000: { roadmap: { avery: 1160, blake: 882, company: 822 }, standup: { avery: 1180, blake: 859, company: 796 }, invoice: { avery: 1167, blake: 890, company: 816 } },
      20000: { roadmap: { avery: 1959, blake: 1463, company: 1374 }, standup: { avery: 1895, blake: 1431, company: 1326 }, invoice: { avery: 1907, blake: 1457, company: 1343 } },
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

  it("keeps each dense word under the keyword window at 1k and over it at 5k and 20k, per viewer and layer", () => {
    const scopes = [
      readScopeWorkspaces(IDENTITIES.avery, {}),
      readScopeWorkspaces(IDENTITIES.blake, {}),
      readScopeWorkspaces(IDENTITIES.blake, { layer: "company" }),
    ];
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
            else expect(count, `${token} at ${size}`).toBeGreaterThan(500);
          }
        }
      }
    }
  });
});
