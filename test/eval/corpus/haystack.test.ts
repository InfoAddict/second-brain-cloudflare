import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COMMON_TOKENS, generateHaystack, type HaystackOptions } from "./haystack";
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
    expect(digest(first)).toBe("c4d5d444affca9665717e24f6104db5bb1498566cf1e91bd40acfa774e50b95d");
    expect(digest(generateHaystack({ ...base, seed: 8 }))).toBe("ce193e0a8c04d19b1c087708ae5c1ec7b5b3fc3918a1b93a815cf833984a5649");
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

  it("keeps exact-duplicate groups under 2% at every scale", () => {
    const rows = generateHaystack({ ...base, count: 20_000 });
    for (const count of [1000, 5000, 20_000]) expect(duplicateShare(rows.slice(0, count))).toBeLessThanOrEqual(0.02);
  });

  it("realizes the requested common rate and exceeds the keyword window in each readable scope", () => {
    const rows = generateHaystack({ ...base, count: 20_000 });
    const pinned = {
      1000: { roadmap: { avery: 153, blake: 120, company: 112 }, standup: { avery: 177, blake: 137, company: 126 }, invoice: { avery: 166, blake: 130, company: 118 } },
      5000: { roadmap: { avery: 817, blake: 619, company: 577 }, standup: { avery: 845, blake: 647, company: 600 }, invoice: { avery: 862, blake: 639, company: 587 } },
      20000: { roadmap: { avery: 3319, blake: 2495, company: 2302 }, standup: { avery: 3403, blake: 2560, company: 2373 }, invoice: { avery: 3495, blake: 2622, company: 2424 } },
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
});
