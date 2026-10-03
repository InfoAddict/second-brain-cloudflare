import { describe, expect, it } from "vitest";
import { decodeVector, encodeVector, parseStandingCache, type StandingCacheV1 } from "../../src/standing/codec";

describe("encodeVector / decodeVector", () => {
  it("round-trips float32 vectors through base64", () => {
    const values = [0.1, -0.5, 1, 0, -1, 3.14159, 1e-3];
    const decoded = decodeVector(encodeVector(values));
    expect(decoded).toBeInstanceOf(Float32Array);
    expect(decoded.length).toBe(values.length);
    for (let i = 0; i < values.length; i++) expect(decoded[i]).toBeCloseTo(values[i], 5);
  });

  it("round-trips a full 384-dimension vector", () => {
    const values = Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.5);
    const decoded = decodeVector(encodeVector(values));
    for (let i = 0; i < values.length; i++) expect(decoded[i]).toBeCloseTo(values[i], 5);
  });

  it("throws on a byte length that is not float32-aligned", () => {
    expect(() => decodeVector("QQ==")).toThrow(/float32-aligned/); // "A" alone, one byte
  });
});

describe("parseStandingCache", () => {
  const valid: StandingCacheV1 = { v: 1, model: "@cf/baai/bge-small-en-v1.5", dim: 384, builtAt: 1000, items: [] };

  it("accepts a value matching the expected model and dim", () => {
    expect(parseStandingCache(valid, { model: valid.model, dim: valid.dim })).toEqual(valid);
  });

  it("rejects a value with another model", () => {
    expect(parseStandingCache(valid, { model: "@cf/baai/bge-base-en-v1.5", dim: 384 })).toBeNull();
  });

  it("rejects a value with another dim", () => {
    expect(parseStandingCache(valid, { model: valid.model, dim: 768 })).toBeNull();
  });

  it("rejects malformed or missing values instead of throwing", () => {
    expect(parseStandingCache(null, { model: "m", dim: 1 })).toBeNull();
    expect(parseStandingCache(undefined, { model: "m", dim: 1 })).toBeNull();
    expect(parseStandingCache("not an object", { model: "m", dim: 1 })).toBeNull();
    expect(parseStandingCache({ v: 2, model: "m", dim: 1, builtAt: 1, items: [] }, { model: "m", dim: 1 })).toBeNull();
    expect(parseStandingCache({ v: 1, model: "m", dim: 1, items: [] }, { model: "m", dim: 1 })).toBeNull();
    expect(parseStandingCache({ v: 1, model: "m", dim: 1, builtAt: 1 }, { model: "m", dim: 1 })).toBeNull();
  });
});
