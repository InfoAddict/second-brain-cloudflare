import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COMMON_TOKENS, generateHaystack, type HaystackOptions } from "./haystack";
import { ACTORS, DAY_MS, EVAL_NOW, WORKSPACES, needleToEntry } from "./types";

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
  rows.filter(row => new RegExp(`\\b${token}\\b`, "i").test(row.content)).length;

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
    expect(digest(first)).toBe("b79d1aeeb3e7103e9ef38d531b82dfae786808ce3f66fa3379a7426f3a46decd");
    expect(digest(generateHaystack({ ...base, seed: 8 }))).toBe("821f3a6453c38db314117d36e022d058afada52c281de5eddfb8be98d9e4881a");
    expect(first).not.toEqual(generateHaystack({ ...base, seed: 8 }));
  });

  it("produces unique ids, bounded timestamps, CJK and multi-chunk notes across workspaces", () => {
    const rows = generateHaystack({ ...base, count: 3000 });
    expect(rows).toHaveLength(3000);
    expect(new Set(rows.map(row => row.id)).size).toBe(3000);
    expect(rows.every(row => row.createdAt <= EVAL_NOW && row.createdAt > EVAL_NOW - 731 * DAY_MS)).toBe(true);
    expect(rows.filter(row => /[぀-ヿ㐀-鿿가-힯]/u.test(row.content)).length).toBeGreaterThan(150);
    expect(rows.filter(row => row.content.length > 1600).length).toBeGreaterThan(30);
    expect(rows.filter(row => row.workspaceId === WORKSPACES.avery).length).toBeGreaterThan(1500);
    expect(rows.filter(row => row.workspaceId === WORKSPACES.company).length).toBeGreaterThan(900);
  });

  it("puts a common token below the 500-row window at 1k and above it at 5k and 20k", () => {
    const rows = generateHaystack({ ...base, count: 20_000 });
    const counts = [1000, 5000, 20_000].map(count => df(rows.slice(0, count), "standup"));
    expect(counts).toEqual([187, 942, 3652]);
    expect(counts[0]).toBeLessThan(500);
    expect(counts[1]).toBeGreaterThan(500);
    expect(counts[2]).toBeGreaterThan(2000);
    expect(COMMON_TOKENS).toContain("standup");
  });
});
