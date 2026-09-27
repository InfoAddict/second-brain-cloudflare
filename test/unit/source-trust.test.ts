import { describe, it, expect } from "vitest";
import { sourceClass, sourceWeight, type SourceClass } from "../../src/recall/source-trust";
import { MIRRORED_SOURCES, TRANSCRIPT_SOURCES } from "../../src/constants";
import { DEFAULTS } from "../../src/config";
import { rerankWithTimeDecay, rerankWithTimeDecayTraced } from "../../src/recall/math";

const NOW = Date.now();

function match(id: string, score: number, created_at: number, tags: string[] = []) {
  return { id, score, metadata: { parentId: id, created_at, tags } };
}

describe("sourceClass", () => {
  it("classifies every MIRRORED_SOURCES value as mirror", () => {
    for (const source of MIRRORED_SOURCES) {
      expect(sourceClass(source, [])).toBe("mirror");
    }
  });

  it("classifies every TRANSCRIPT_SOURCES value as transcript, including any label added later", () => {
    for (const source of TRANSCRIPT_SOURCES) {
      expect(sourceClass(source, [])).toBe("transcript");
    }
  });

  it("classifies a synthesized-tagged row as system", () => {
    expect(sourceClass("api", ["synthesized"])).toBe("system");
  });

  it("classifies an auto-insight-tagged row as system", () => {
    expect(sourceClass(undefined, ["auto-insight"])).toBe("system");
  });

  it("classifies an unknown source as direct", () => {
    expect(sourceClass("phone", [])).toBe("direct");
  });

  it("classifies a missing source as direct", () => {
    expect(sourceClass(undefined, [])).toBe("direct");
  });

  it("a mirrored source wins over a system tag (first match wins)", () => {
    expect(sourceClass("email-gmail", ["synthesized"])).toBe("mirror");
  });
});

describe("sourceWeight", () => {
  const cfg = { ...DEFAULTS, SOURCE_WEIGHT_MIRROR: 0.85, SOURCE_WEIGHT_TRANSCRIPT: 0.9, SOURCE_WEIGHT_SYSTEM: 0.95 };

  it.each<[SourceClass, number]>([
    ["mirror", 0.85],
    ["transcript", 0.9],
    ["system", 0.95],
    ["direct", 1.0],
  ])("returns the configured weight for class %s", (cls, expected) => {
    expect(sourceWeight(cls, cfg)).toBe(expected);
  });
});

describe("source_weight in recall ranking", () => {
  const cfg = { ...DEFAULTS, SOURCE_WEIGHT_MIRROR: 0.85, SOURCE_WEIGHT_TRANSCRIPT: 0.9, SOURCE_WEIGHT_SYSTEM: 0.95 };

  it("with SOURCE_WEIGHT_MIRROR 0.85, an email ranks below an equally scored direct note", () => {
    const email = match("email", 0.9, NOW - 1000);
    const note = match("note", 0.9, NOW - 1000);
    const d1Sources = new Map([["email", "email-gmail"], ["note", "api"]]);
    const result = rerankWithTimeDecay(
      [email, note], new Map(), new Map(), [], new Map(), new Map(), new Map(), cfg, { d1Sources },
    );
    expect(result[0].id).toBe("note");
    expect(result[1].id).toBe("email");
  });

  it("canonical rows get source_weight 1.0 in every class", () => {
    const d1Tags = new Map([["mirror-row", ["status:canonical"]]]);
    const d1Sources = new Map([["mirror-row", "email-gmail"]]);
    const [traced] = rerankWithTimeDecayTraced(
      [match("mirror-row", 0.9, NOW)], new Map(), new Map(), [], new Map(), new Map(), d1Tags, cfg, { d1Sources },
    );
    expect(traced.multipliers.source_weight).toBe(1.0);
  });

  it("source comes from D1 when hops = 0; metadata source is overridden", () => {
    const withMetaSource = { id: "x", score: 0.9, metadata: { parentId: "x", created_at: NOW, source: "api" } };
    const d1Sources = new Map([["x", "email-gmail"]]);
    const [traced] = rerankWithTimeDecayTraced(
      [withMetaSource], new Map(), new Map(), [], new Map(), new Map(), new Map(), cfg, { d1Sources },
    );
    expect(traced.multipliers.source_weight).toBe(0.85);
  });

  it("falls back to metadata source when d1Sources has no entry for the id", () => {
    const withMetaSource = { id: "y", score: 0.9, metadata: { parentId: "y", created_at: NOW, source: "email-gmail" } };
    const [traced] = rerankWithTimeDecayTraced(
      [withMetaSource], new Map(), new Map(), [], new Map(), new Map(), new Map(), cfg, {},
    );
    expect(traced.multipliers.source_weight).toBe(0.85);
  });

  it("with all weights 1.0 (the shipped default), source_weight never demotes a score", () => {
    const email = match("email", 0.9, NOW - 1000);
    const d1Sources = new Map([["email", "email-gmail"]]);
    const [traced] = rerankWithTimeDecayTraced(
      [email], new Map(), new Map(), [], new Map(), new Map(), new Map(), DEFAULTS, { d1Sources },
    );
    expect(traced.multipliers.source_weight).toBe(1.0);
  });

  it("explain multipliers include source_weight and reconstruct the score", () => {
    const m = match("z", 0.9, NOW - 1000);
    const d1Sources = new Map([["z", "email-gmail"]]);
    const [traced] = rerankWithTimeDecayTraced(
      [m], new Map(), new Map(), [], new Map(), new Map(), new Map(), cfg, { d1Sources },
    );
    const mult = traced.multipliers;
    const reconstructed = m.score * mult.combined * mult.importance * mult.tag_boost
      * mult.append_penalty * mult.rolled_up_penalty * mult.source_weight;
    expect(traced.match.score).toBeCloseTo(reconstructed, 10);
    expect(mult.source_weight).toBe(0.85);
  });
});
