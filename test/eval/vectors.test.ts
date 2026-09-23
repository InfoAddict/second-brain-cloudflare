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
});
