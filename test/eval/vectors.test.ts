import { describe, expect, it } from "vitest";
import { controlledVector, cosine, hashVector } from "./vectors";

describe("vectors", () => {
  it("hashVector is deterministic, unit length, and text-sensitive", () => {
    const a = hashVector("hello", 384);
    expect(a).toEqual(hashVector("hello", 384));
    expect(a).toHaveLength(384);
    expect(Math.hypot(...a)).toBeCloseTo(1, 10);
    expect(cosine(a, hashVector("world", 384))).toBeLessThan(0.3);
  });

  it("controlledVector hits the requested cosine exactly and is unit length", () => {
    const q = hashVector("query", 384);
    for (const target of [0.99, 0.76, 0.3, 0]) {
      const v = controlledVector(q, target, `id-${target}`);
      expect(cosine(v, q)).toBeCloseTo(target, 9);
      expect(Math.hypot(...v)).toBeCloseTo(1, 9);
    }
    expect(controlledVector(q, 0.5, "x")).toEqual(controlledVector(q, 0.5, "x"));
    expect(controlledVector(q, 0.5, "x")).not.toEqual(controlledVector(q, 0.5, "y"));
  });

  it("cosine throws on zero vectors, mismatched dimensions, empty and non-finite input", () => {
    expect(() => cosine([0, 0], [1, 0])).toThrow(/zero/);
    expect(() => cosine([1, 0], [0, 0])).toThrow(/zero/);
    expect(() => cosine([1, 0], [1])).toThrow(/dimension/);
    expect(() => cosine([], [])).toThrow(/empty/);
    expect(() => cosine([1, Number.NaN], [1, 0])).toThrow(/finite/);
    expect(() => cosine([1, Infinity], [1, 0])).toThrow(/finite/);
  });

  it("cosine does not overflow or underflow on extreme finite magnitudes", () => {
    expect(cosine([1e200, 1e200], [1e200, 1e200])).toBeCloseTo(1, 12);
    expect(cosine([1e200, 0], [0, 1e-200])).toBeCloseTo(0, 12);
    expect(cosine([1e-200, 1e-200], [2e-200, 2e-200])).toBeCloseTo(1, 12);
    expect(cosine([3, 4], [4, 3])).toBeCloseTo(24 / 25, 12);
    expect(cosine([1, 2, 3], [-1, -2, -3])).toBe(-1); // clamped, never below -1
  });

  it("controlledVector rejects degenerate inputs instead of returning NaN", () => {
    const q = hashVector("q", 8);
    expect(() => controlledVector([1], 0.5, "one")).toThrow(/dimension/);
    expect(() => controlledVector([0, 0, 0], 0.5, "zero")).toThrow(/zero/);
    expect(() => controlledVector([1, Number.NaN], 0.5, "nan")).toThrow(/finite/);
    expect(() => controlledVector(q, 1.5, "big")).toThrow(/targetCosine/);
    expect(() => controlledVector(q, Number.NaN, "nan")).toThrow(/targetCosine/);
    expect(controlledVector(q, 1, "one").every(Number.isFinite)).toBe(true);
  });
});
