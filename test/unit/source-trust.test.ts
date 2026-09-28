import { describe, it, expect } from "vitest";
import {
  sourceClass, sourceWeight, type SourceClass,
  templateSignature, collapseNearDuplicates,
  SOURCE_LIFT_WORDS, TRANSACTIONAL_LIFT_WORDS, ENUMERATE_RE, sourceWordLift, tagLift, collapseLift,
  type CollapseCandidate,
  liftFor, applyOccupancyCap, type OccupancyCandidate,
} from "../../src/recall/source-trust";
import { mulberry32 } from "../eval/stats";
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

describe("templateSignature (T-0089.3.1, 4.4)", () => {
  const sig = (content: string) => templateSignature(content, "email-gmail").split("|")[0];

  it.each<[string, string]>([
    ["Your direct deposit of $1,234.56 has been credited to account ending 4321",
      "your direct deposit of # has been credited to account ending #"],
    ["Flight booking confirmation AB123456 departing Aug 11",
      "flight booking confirmation # departing #"],
    ["Statement ready: balance $432.10 as of 2026-08-11",
      "statement ready: balance # as of #"],
    ["Prescription refill RX998877 ready for pickup on 11/08",
      "prescription refill # ready for pickup on #"],
    ["Order 445566 has shipped and will arrive Sep 3rd",
      "order # has shipped and will arrive #"],
    ["Invoice INV004421 for €120 is due",
      "invoice # for # is due"],
    ["Your payment of 50 dollars was received",
      "your payment of # dollars was received"],
    ["Booking reference XJ2Q9Z confirmed for 12/25/2026",
      "booking reference # confirmed for #"],
  ])("strips amounts, dates, digits and ids from %j", (content, expected) => {
    expect(sig(content)).toBe(expected);
  });

  it("keeps ordinary words untouched", () => {
    expect(sig("Team standup notes and next steps")).toBe("team standup notes and next steps");
  });

  it("appends the source after a pipe", () => {
    expect(templateSignature("hello world", "email-gmail")).toBe("hello world|email-gmail");
    expect(templateSignature("hello world", "notion")).toBe("hello world|notion");
  });

  it("From: lines fall back to the Subject line", () => {
    const content = "From: billing@example.com\nSubject: Your receipt 4421\nBody text follows";
    expect(sig(content)).toBe("subject: your receipt #");
  });

  it("From: with no Subject line falls back to the From line itself", () => {
    const content = "From: billing@example.com\nBody text follows";
    expect(sig(content)).toBe("from: billing@example.com");
  });
});

const mkCandidate = (over: Partial<CollapseCandidate> & { id: string }): CollapseCandidate => ({
  content: "recurring notice content",
  source: "email-gmail",
  tags: [],
  createdAt: 1000,
  ...over,
});

describe("collapseNearDuplicates (T-0089.3.1, 4.4)", () => {
  it("keeps distinct messages with the same subject when their bodies answer different questions", () => {
    const candidates = [
      mkCandidate({ id: "wrong", source: "email-gmail", content: "Subject: Reception details\nVenue: North Hall" }),
      mkCandidate({ id: "right", source: "email-gmail", content: "Subject: Reception details\nVenue: South Hall" }),
    ];
    expect(collapseNearDuplicates(candidates).kept.map(c => c.id)).toEqual(["wrong", "right"]);
  });
  it("groups mirror rows with the same signature; the best-ranked (first) member stays", () => {
    const candidates = [
      mkCandidate({ id: "best", content: "Statement ready: balance $10.00 as of 2026-08-11", createdAt: 3000 }),
      mkCandidate({ id: "second", content: "Statement ready: balance $20.00 as of 2026-08-04", createdAt: 2000 }),
      mkCandidate({ id: "third", content: "Statement ready: balance $30.00 as of 2026-07-28", createdAt: 1000 }),
    ];
    const { kept, similarById } = collapseNearDuplicates(candidates);
    expect(kept.map(c => c.id)).toEqual(["best"]);
    expect(similarById.get("best")).toEqual([
      { id: "second", createdAt: 2000 },
      { id: "third", createdAt: 1000 },
    ]);
  });

  it("attaches up to 5 similar matches, newest first", () => {
    const candidates = [
      mkCandidate({ id: "best", createdAt: 100 }),
      ...Array.from({ length: 6 }, (_, i) => mkCandidate({ id: `dup${i}`, createdAt: 50 - i })),
    ];
    const { kept, similarById } = collapseNearDuplicates(candidates);
    expect(kept.map(c => c.id)).toEqual(["best"]);
    const similar = similarById.get("best")!;
    expect(similar).toHaveLength(5);
    expect(similar.map(s => s.id)).toEqual(["dup0", "dup1", "dup2", "dup3", "dup4"]);
  });

  it("two notes with the same first line never collapse", () => {
    const candidates = [
      mkCandidate({ id: "a", source: "api", content: "Team standup notes" }),
      mkCandidate({ id: "b", source: "api", content: "Team standup notes" }),
    ];
    expect(collapseNearDuplicates(candidates).kept.map(c => c.id)).toEqual(["a", "b"]);
  });

  it("transcripts never collapse, even with an identical template signature", () => {
    const candidates = [
      mkCandidate({ id: "a", source: "claude-code", content: "Statement ready: balance $10.00 as of 2026-08-11" }),
      mkCandidate({ id: "b", source: "claude-code", content: "Statement ready: balance $20.00 as of 2026-08-04" }),
    ];
    expect(collapseNearDuplicates(candidates).kept.map(c => c.id)).toEqual(["a", "b"]);
  });

  it("never shortens: an all-mirror-duplicate list collapses to one and does not vanish", () => {
    const candidates = Array.from({ length: 4 }, (_, i) => mkCandidate({ id: `m${i}`, createdAt: 100 - i }));
    const { kept } = collapseNearDuplicates(candidates);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe("m0");
  });

  it("order within a group's survivor position is preserved for unrelated rows", () => {
    const candidates = [
      mkCandidate({ id: "real1", source: "api", content: "Unique note one" }),
      mkCandidate({ id: "dupA", createdAt: 100 }),
      mkCandidate({ id: "dupB", createdAt: 50 }),
      mkCandidate({ id: "real2", source: "api", content: "Unique note two" }),
    ];
    expect(collapseNearDuplicates(candidates).kept.map(c => c.id)).toEqual(["real1", "dupA", "real2"]);
  });
});

describe("lift conditions (T-0089.3.1, 4.3, 4.4)", () => {
  it("a source word lifts (mail, calendar, notes, code, sessions)", () => {
    for (const word of ["email", "meeting", "notion", "commit", "transcript", "claude code"]) {
      expect(sourceWordLift(`show me the ${word} from yesterday`)).toBe(true);
    }
  });

  it("an unrelated query does not lift", () => {
    expect(sourceWordLift("what did I decide about pricing")).toBe(false);
  });

  it("transactional words only lift when explicitly included", () => {
    expect(sourceWordLift("find the deposit from payroll")).toBe(false);
    expect(sourceWordLift("find the deposit from payroll", true)).toBe(true);
  });

  it("a tag filter lifts when it is a source-lift word or a mirror-written tag", () => {
    expect(tagLift("email")).toBe(true);
    expect(tagLift("calendar")).toBe(true);
    expect(tagLift("work")).toBe(false);
    expect(tagLift(undefined)).toBe(false);
  });

  it("enumerating intent lifts the collapse (all, every, each, list, show, how many, history of)", () => {
    for (const q of ["show all my emails", "list every note", "how many receipts do I have", "history of payments"]) {
      expect(ENUMERATE_RE.test(q)).toBe(true);
    }
    expect(ENUMERATE_RE.test("what is the plan")).toBe(false);
  });

  it("collapseLift is true for a source word, a mirror tag, or an enumerating query", () => {
    expect(collapseLift("show me my email", undefined)).toBe(true);
    expect(collapseLift("random query", "notion")).toBe(true);
    expect(collapseLift("show all the receipts", undefined)).toBe(true);
    expect(collapseLift("random query", undefined)).toBe(false);
  });

  it("SOURCE_LIFT_WORDS and TRANSACTIONAL_LIFT_WORDS are disjoint word lists", () => {
    expect(SOURCE_LIFT_WORDS.some(w => TRANSACTIONAL_LIFT_WORDS.includes(w))).toBe(false);
  });

  it("liftFor is true for a source word or a mirror tag filter, but a project filter is not a parameter it can consult (P3)", () => {
    expect(liftFor("show me my email", undefined)).toBe(true);
    expect(liftFor("random query", "calendar")).toBe(true);
    expect(liftFor("random query", undefined)).toBe(false);
    // Enumerating intent alone does not lift the cap (only the collapse).
    expect(liftFor("show all my notes", undefined)).toBe(false);
  });
});

const mk = (over: Partial<OccupancyCandidate> = {}): OccupancyCandidate => ({ source: "api", tags: [], ...over });
const mirrorRow = () => mk({ source: "email-gmail" });
const transcriptRow = () => mk({ source: "claude-code" });
const directRow = () => mk({ source: "api" });

describe("applyOccupancyCap (T-0089.3.1, 4.3)", () => {
  it("at share 1.0 (off), the list passes through unchanged", () => {
    const list = [mirrorRow(), mirrorRow(), directRow(), mirrorRow()];
    expect(applyOccupancyCap(list, 1.0)).toEqual(list);
  });

  it("at share 0.4, the top 5 hold at most 2 mail rows (the spec's worked example), not 3 from floating-point drift", () => {
    // 0.4 * 5 === 2.0000000000000004 in IEEE 754: a naive Math.ceil gives 3.
    // Interleaved with enough direct rows in reserve that position 5 is not
    // the exhausted case (a later direct row is still available to promote).
    const list = [mirrorRow(), directRow(), mirrorRow(), directRow(), mirrorRow(), directRow(), mirrorRow(), directRow()];
    const out = applyOccupancyCap(list, 0.4);
    expect(out.slice(0, 5).filter(m => m.source !== "api")).toHaveLength(2);
  });

  it.each(Array.from({ length: 30 }, (_, seed) => seed))(
    "at share 0.4, every prefix p has at most ceil(0.4p) capped rows while a direct row remains (seed %i)",
    (seed) => {
      const rand = mulberry32(seed + 1);
      const n = 20;
      const list = Array.from({ length: n }, () => (rand() < 0.7 ? mirrorRow() : directRow()));
      const out = applyOccupancyCap(list, 0.4);
      expect(out).toHaveLength(n);
      let cappedSoFar = 0;
      for (let p = 1; p <= n; p++) {
        if (out[p - 1].source !== "api") cappedSoFar++;
        const remainingHasDirect = out.slice(p).some(m => m.source === "api");
        if (remainingHasDirect) expect(cappedSoFar).toBeLessThanOrEqual(Math.ceil(0.4 * p));
      }
    },
  );

  it("deferred rows re-enter at the first allowed position, in their own order", () => {
    // share 0.5: quota at p=1,2,3,4 is 1,1,2,2. Two mirrors up front exceed
    // quota 1 at p=2, so the second mirror defers behind the first direct row.
    const m1 = mirrorRow(), m2 = mirrorRow(), d1 = directRow(), d2 = directRow();
    const out = applyOccupancyCap([m1, m2, d1, d2], 0.5);
    expect(out).toEqual([m1, d1, m2, d2]);
  });

  it("never shortens: an all-mirror list fills topK", () => {
    const list = Array.from({ length: 5 }, mirrorRow);
    expect(applyOccupancyCap(list, 0.4)).toHaveLength(5);
  });

  it("transcripts count toward the share exactly like mirror rows", () => {
    const list = [transcriptRow(), transcriptRow(), directRow()];
    const out = applyOccupancyCap(list, 0.4);
    // quota at p=1 is 1: the first transcript is taken, the second defers behind the direct row.
    expect(out.map(m => m.source)).toEqual(["claude-code", "api", "claude-code"]);
  });

  it("order within each group (capped, direct) is preserved", () => {
    const a = mirrorRow(), b = mirrorRow(), c = directRow(), d = directRow();
    const out = applyOccupancyCap([a, c, b, d], 1.0);
    expect(out).toEqual([a, c, b, d]);
  });

  it("the pinned index keeps its position and still counts toward the share", () => {
    // share 0.4: without a pin, only 1 of the first 2 mirrors would be kept at p=1..2.
    // Pinning index 1 (the second mirror) forces it to stay at output position 1.
    const m1 = mirrorRow(), m2 = mirrorRow(), d1 = directRow();
    const out = applyOccupancyCap([m1, m2, d1], 0.4, 1);
    expect(out[1]).toBe(m2);
    // The first mirror, not pinned, defers past the direct row since the pin already spent the quota.
    expect(out).toEqual([m1, m2, d1]);
  });

  it("result(topK=5) is a prefix of result(topK=10) when the lookahead is not exhausted", () => {
    // Alternating capped/direct rows: plenty of direct rows within both slice
    // lengths, so neither call runs out of a non-capped row to promote.
    const list = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? mirrorRow() : directRow()));
    const capped = applyOccupancyCap(list, 0.4);
    expect(capped.slice(0, 10)).toEqual(applyOccupancyCap(list.slice(0, 20), 0.4).slice(0, 10));
  });

  it("the exhausted case (fewer non-capped rows than the lookahead needs) is documented and stable: the shorter input still returns everything it has", () => {
    // Every row is capped: there is no non-capped row to promote, so both calls degrade to input order.
    const list = Array.from({ length: 8 }, mirrorRow);
    expect(applyOccupancyCap(list, 0.4)).toEqual(list);
    expect(applyOccupancyCap(list.slice(0, 4), 0.4)).toEqual(list.slice(0, 4));
  });
});
