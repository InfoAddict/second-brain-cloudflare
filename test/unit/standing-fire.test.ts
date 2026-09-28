import { describe, expect, it } from "vitest";
import { encodeVector, type StandingCacheV1 } from "../../src/standing/codec";
import { selectStandingFires } from "../../src/standing/fire";

const unit = (angleFromX: number): number[] => [Math.cos(angleFromX), Math.sin(angleFromX)];
const cacheOf = (items: StandingCacheV1["items"]): StandingCacheV1 => ({ v: 1, model: "m", dim: 2, builtAt: 0, items });
const item = (id: string, vecs: number[][], opts: { projects?: string[]; createdAt?: number } = {}) =>
  ({ id, projects: opts.projects ?? [], createdAt: opts.createdAt ?? 0, vecs: vecs.map(encodeVector) });

describe("selectStandingFires", () => {
  it("fires at the threshold, not below", () => {
    const query = unit(0);
    const cache = cacheOf([item("m", [unit(0.4)])]);
    const [{ score }] = selectStandingFires(query, [cache], { threshold: -1, maxFires: 2 });
    expect(selectStandingFires(query, [cache], { threshold: score, maxFires: 2 })).toHaveLength(1);
    expect(selectStandingFires(query, [cache], { threshold: score + 1e-6, maxFires: 2 })).toHaveLength(0);
  });

  it("scores an item by the max cosine over its chunks", () => {
    const query = unit(0);
    const caches = [cacheOf([item("multi", [unit(1.5), unit(0.05)])])]; // one far chunk, one near chunk
    const [fired] = selectStandingFires(query, caches, { threshold: 0.9, maxFires: 2 });
    expect(fired.id).toBe("multi");
    expect(fired.score).toBeCloseTo(Math.cos(0.05), 5);
  });

  it("returns at most maxFires*2 candidates, sorted by score then createdAt then id", () => {
    const query = unit(0);
    const items = [
      item("b", [unit(0.1)], { createdAt: 5 }),
      item("a-older", [unit(0.1)], { createdAt: 1 }),
      item("a-newer", [unit(0.1)], { createdAt: 2 }),
      item("best", [unit(0.01)], { createdAt: 9 }),
      item("worst-of-the-fired", [unit(0.2)], { createdAt: 9 }),
    ];
    const fired = selectStandingFires(query, [cacheOf(items)], { threshold: 0.9, maxFires: 2 });
    expect(fired).toHaveLength(4); // maxFires * 2
    expect(fired[0].id).toBe("best"); // highest score
    // "b", "a-older", "a-newer" all share a score (same angle); createdAt ascending breaks the tie.
    expect(fired.slice(1).map(f => f.id)).toEqual(["a-older", "a-newer", "b"]);
  });

  it("caps at maxFires*2 even with many qualifying candidates", () => {
    const query = unit(0);
    const items = Array.from({ length: 10 }, (_, i) => item(`m${i}`, [unit(0.01)], { createdAt: i }));
    expect(selectStandingFires(query, [cacheOf(items)], { threshold: 0.9, maxFires: 2 })).toHaveLength(4);
  });

  it("a project-scoped item fires only for a matching slug or alias", () => {
    const query = unit(0);
    const scoped = cacheOf([item("proj", [unit(0.01)], { projects: ["work"] })]);
    expect(selectStandingFires(query, [scoped], { threshold: 0.9, maxFires: 2 })).toHaveLength(0);
    expect(selectStandingFires(query, [scoped], { threshold: 0.9, maxFires: 2, project: { slug: "other", aliases: [] } })).toHaveLength(0);
    expect(selectStandingFires(query, [scoped], { threshold: 0.9, maxFires: 2, project: { slug: "work", aliases: [] } })).toHaveLength(1);
    expect(selectStandingFires(query, [scoped], { threshold: 0.9, maxFires: 2, project: { slug: "other", aliases: ["work"] } })).toHaveLength(1);
  });

  it("an unscoped item fires in a project recall", () => {
    const query = unit(0);
    const unscoped = cacheOf([item("any", [unit(0.01)])]);
    expect(selectStandingFires(query, [unscoped], { threshold: 0.9, maxFires: 2, project: { slug: "work", aliases: [] } })).toHaveLength(1);
  });

  it("carries the workspaceIndex of the cache a fire came from", () => {
    const query = unit(0);
    const caches = [cacheOf([item("a", [unit(0.01)])]), cacheOf([item("b", [unit(0.01)])])];
    const fired = selectStandingFires(query, caches, { threshold: 0.9, maxFires: 2 });
    expect(fired.find(f => f.id === "a")?.workspaceIndex).toBe(0);
    expect(fired.find(f => f.id === "b")?.workspaceIndex).toBe(1);
  });
});

describe("selectStandingFires CPU budget", () => {
  it("selects over a full cache (50 items, 2 chunks) in well under the free-tier D1 CPU budget", () => {
    // 50 items x 2 chunks x 384 dims: the full standing cap, benchmark with a 5x margin (design's 2ms target).
    // Not a lock: a loose, warmed-up bound that would still catch an accidental O(n^2) or unbounded regression.
    const items = Array.from({ length: 50 }, (_, i) =>
      item(`m${i}`, [Array.from({ length: 384 }, () => Math.random()), Array.from({ length: 384 }, () => Math.random())], { createdAt: i }));
    const query = Array.from({ length: 384 }, () => Math.random());
    const run = () => selectStandingFires(query, [cacheOf(items)], { threshold: 0.5, maxFires: 2 });
    for (let i = 0; i < 20; i++) run(); // warm the JIT before timing, as a cold interpreted pass dwarfs the real cost
    const start = performance.now();
    run();
    expect(performance.now() - start).toBeLessThan(50);
  });
});
