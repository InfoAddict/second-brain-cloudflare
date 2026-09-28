/**
 * Plain-math calibration for the decision ledger (src/decisions/calibration.ts):
 * buckets, folding, Brier, gate n's, and wording that always carries n. No
 * model call, no SQL — a pure function over already-read rows.
 */
import { describe, it, expect } from "vitest";
import {
  calibrate,
  bucketFor,
  fold,
  wilsonInterval,
  type DecisionOutcomeRow,
} from "../../src/decisions/calibration";

const GATES = { CALIBRATION_MIN_N: 10, CALIBRATION_MIN_BUCKET_N: 5, CALIBRATION_MIN_TOPIC_N: 5 };

function row(confidence: number | null, source: "stated" | "inferred" | null, outcome: DecisionOutcomeRow["outcome"], tags: string[] = []): DecisionOutcomeRow {
  return { confidence, source, outcome, tags };
}

describe("bucketFor", () => {
  it("uses integer-hundredths edges: 0.69 -> 60-69, 0.70 -> 70-79, 0.95 -> 90-95", () => {
    expect(bucketFor(0.69)).toBe("60-69");
    expect(bucketFor(0.70)).toBe("70-79");
    expect(bucketFor(0.95)).toBe("90-95");
    expect(bucketFor(0.50)).toBe("50-59");
    expect(bucketFor(0.59)).toBe("50-59");
    expect(bucketFor(0.80)).toBe("80-89");
    expect(bucketFor(0.89)).toBe("80-89");
    expect(bucketFor(0.90)).toBe("90-95");
  });
});

describe("fold", () => {
  it("folds a confidence below 0.5 onto the other outcome: 0.3 right counts as 0.7 wrong", () => {
    expect(fold(0.3, 1)).toEqual({ pPrime: 0.7, hitPrime: 0 });
  });

  it("leaves 0.5 unfolded", () => {
    expect(fold(0.5, 1)).toEqual({ pPrime: 0.5, hitPrime: 1 });
    expect(fold(0.5, 0)).toEqual({ pPrime: 0.5, hitPrime: 0 });
  });

  it("leaves values at or above 0.5 unfolded", () => {
    expect(fold(0.7, 0.5)).toEqual({ pPrime: 0.7, hitPrime: 0.5 });
  });

  it("mixed counts as a 0.5 hit both before and after folding", () => {
    expect(fold(0.3, 0.5)).toEqual({ pPrime: 0.7, hitPrime: 0.5 });
    expect(fold(0.8, 0.5)).toEqual({ pPrime: 0.8, hitPrime: 0.5 });
  });
});

describe("wilsonInterval", () => {
  it("brackets a fractional proportion inside 0 to 1", () => {
    const [lo, hi] = wilsonInterval(3.5, 7);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });

  it("returns the full [0, 1] range for n = 0", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });

  it("narrows as n grows for the same proportion", () => {
    const [lo1, hi1] = wilsonInterval(5, 10);
    const [lo2, hi2] = wilsonInterval(50, 100);
    expect(hi2 - lo2).toBeLessThan(hi1 - lo1);
  });
});

describe("calibrate: readiness gates", () => {
  it("is not ready below the overall minimum n, and reports how many are needed", () => {
    const rows = [row(0.7, "stated", "right"), row(0.6, "stated", "wrong"), row(0.8, "inferred", "right")];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.n).toBe(3);
      expect(result.needed).toBe(10);
    }
  });

  it("does not count unknown or no-confidence rows toward n", () => {
    const rows = [
      row(0.7, "stated", "right"), row(0.6, "stated", "right"), row(0.6, "stated", "right"),
      row(0.6, "stated", "right"), row(0.6, "stated", "right"), row(0.6, "stated", "right"),
      row(0.6, "stated", "right"), row(0.6, "stated", "right"), row(0.6, "stated", "right"),
      row(null, "stated", "unknown"), row(0.6, null, null),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.n).toBe(9);
  });

  it("hides a bucket with fewer than the per-bucket minimum, but still reports overall readiness", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => row(0.7, "stated", "right" as const)),
      row(0.9, "stated", "right"), row(0.9, "stated", "wrong"),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) {
      const b70 = result.buckets.find((b) => b.bucket === "70-79");
      const b90 = result.buckets.find((b) => b.bucket === "90-95");
      expect(b70?.shown).toBe(true);
      expect(b90?.shown).toBe(false);
      expect(b90?.n).toBe(2);
    }
  });
});

describe("calibrate: math", () => {
  it("scores mixed as 0.5, and folds correctly across a mixed set", () => {
    const rows = [
      ...Array.from({ length: 6 }, () => row(0.7, "stated", "right" as const)),
      ...Array.from({ length: 4 }, () => row(0.7, "stated", "wrong" as const)),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) {
      const b = result.buckets.find((x) => x.bucket === "70-79")!;
      expect(b.n).toBe(10);
      expect(b.hitRate).toBeCloseTo(0.6, 5);
      expect(b.meanStated).toBeCloseTo(0.7, 5);
    }
  });

  it("computes Brier score on raw (unfolded) confidence and hit values", () => {
    // 0.3 confidence, wrong (hit=0): raw error (0.3-0)^2 = 0.09
    // 0.8 confidence, right (hit=1): raw error (0.8-1)^2 = 0.04
    const rows = [
      ...Array.from({ length: 5 }, () => row(0.3, "stated", "wrong" as const)),
      ...Array.from({ length: 5 }, () => row(0.8, "stated", "right" as const)),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) expect(result.brier).toBeCloseTo((0.09 + 0.04) / 2, 5);
  });

  it("splits n by stated and inferred", () => {
    const rows = [
      ...Array.from({ length: 6 }, () => row(0.7, "stated", "right" as const)),
      ...Array.from({ length: 4 }, () => row(0.7, "inferred", "right" as const)),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.n).toBe(10);
      expect(result.nStated).toBe(6);
      expect(result.nInferred).toBe(4);
    }
  });

  it("direction is over when stated confidence sits above the Wilson upper bound of the hit rate", () => {
    // Ten calls at 0.9 confidence, only 3 right: badly overconfident.
    const rows = [
      ...Array.from({ length: 3 }, () => row(0.9, "stated", "right" as const)),
      ...Array.from({ length: 7 }, () => row(0.9, "stated", "wrong" as const)),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) expect(result.direction).toBe("over");
  });

  it("direction is under when stated confidence sits below the Wilson lower bound of the hit rate", () => {
    const rows = [
      ...Array.from({ length: 9 }, () => row(0.55, "stated", "right" as const)),
      ...Array.from({ length: 1 }, () => row(0.55, "stated", "wrong" as const)),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) expect(result.direction).toBe("under");
  });

  it("direction is in_line when confidence roughly matches outcomes", () => {
    const rows = [
      ...Array.from({ length: 7 }, () => row(0.7, "stated", "right" as const)),
      ...Array.from({ length: 3 }, () => row(0.7, "stated", "wrong" as const)),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) expect(result.direction).toBe("in_line");
  });
});

describe("calibrate: topic", () => {
  it("names exactly one topic: the largest |gap| among tags on >= 5 scored rows, excluding in_line", () => {
    const hiring = Array.from({ length: 6 }, () => row(0.9, "stated", "right" as const, ["hiring"]))
      .map((r, i) => (i < 1 ? { ...r, outcome: "right" as const } : { ...r, outcome: "wrong" as const }));
    // 1 right, 5 wrong at 0.9 confidence -> badly overconfident on "hiring"
    const other = Array.from({ length: 4 }, () => row(0.7, "stated", "right" as const));
    const result = calibrate([...hiring, ...other], GATES);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.topic?.name).toBe("hiring");
      expect(result.topic?.n).toBe(6);
      expect(result.topic?.direction).not.toBe("in_line");
    }
  });

  it("excludes reserved tags, project: tags, and axis tags from topic candidates", () => {
    const rows = [
      ...Array.from({ length: 5 }, () =>
        row(0.9, "stated", "wrong" as const, ["status:canonical", "project:acme", "task", "personal"])),
      ...Array.from({ length: 5 }, () => row(0.7, "stated", "right" as const)),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) expect(result.topic).toBeNull();
  });

  it("requires at least the per-topic minimum n", () => {
    const rows = [
      ...Array.from({ length: 4 }, () => row(0.9, "stated", "wrong" as const, ["hiring"])),
      ...Array.from({ length: 6 }, () => row(0.7, "stated", "right" as const)),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) expect(result.topic).toBeNull();
  });
});

describe("calibrate: wording (18-copy-deck.md section 5.3)", () => {
  it("the not-ready line names how many exist and never overclaims", () => {
    const rows = [row(0.7, "stated", "right"), row(0.6, "stated", "wrong")];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.line).toBe("You'll see how your confidence compares with what happened after 10 reviewed decisions. You have 2 so far.");
    }
  });

  it("the ready line (direction over or under) carries the headline bucket's own n, says 'so far', and names an estimated-from-wording count only when the bucket has inferred rows", () => {
    // All 14 at 0.7 confidence, 6 right + 3 wrong stated, 5 wrong inferred:
    // one bucket (70-79), so its n is also the overall n here — the
    // bucket-vs-overall distinction is exercised by the honesty-fix test below.
    const rows = [
      ...Array.from({ length: 6 }, () => row(0.7, "stated", "right" as const)),
      ...Array.from({ length: 3 }, () => row(0.7, "stated", "wrong" as const)),
      ...Array.from({ length: 5 }, () => row(0.7, "inferred", "wrong" as const)),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.direction).not.toBe("in_line");
      expect(result.line).toBe("So far, your 70% calls came true 43% of the time, based on 14 decisions. For 5 of them, the confidence was estimated from your wording.");
      expect(result.line).not.toMatch(/always|never/i);
      expect(result.line).not.toMatch(/\bn=/);
      expect(result.line).not.toContain("inferred");
    }
  });

  it("drops the second sentence when the headline bucket has no inferred rows", () => {
    const rows = [
      ...Array.from({ length: 3 }, () => row(0.9, "stated", "right" as const)),
      ...Array.from({ length: 7 }, () => row(0.9, "stated", "wrong" as const)),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.direction).not.toBe("in_line");
      expect(result.line).toBe("So far, your 90% calls came true 30% of the time, based on 10 decisions.");
    }
  });

  it("[HONESTY FIX] cites the headline bucket's own n, never the total, next to that bucket's rate", () => {
    // 5 decisions in the 70% bucket (1 right, 4 wrong) plus 9 more spread
    // across the other buckets — 14 decisions overall. The old code cited
    // "(n=14)" next to a rate built from only 5 of them.
    const bucket70 = [
      row(0.7, "stated", "right" as const),
      row(0.7, "stated", "wrong" as const),
      row(0.7, "stated", "wrong" as const),
      row(0.7, "stated", "wrong" as const),
      row(0.7, "stated", "wrong" as const),
    ];
    const bucket50 = Array.from({ length: 2 }, () => row(0.5, "stated", "right" as const));
    const bucket60 = Array.from({ length: 2 }, () => row(0.6, "stated", "right" as const));
    const bucket80 = Array.from({ length: 2 }, () => row(0.85, "stated", "right" as const));
    const bucket90 = [
      row(0.95, "stated", "right" as const),
      row(0.95, "stated", "wrong" as const),
      row(0.95, "stated", "wrong" as const),
    ];
    const rows = [...bucket70, ...bucket50, ...bucket60, ...bucket80, ...bucket90];

    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.n).toBe(14);
      expect(result.headlineBucket).toBe("70-79");
      const headline = result.buckets.find((b) => b.bucket === "70-79")!;
      expect(headline.n).toBe(5);
      expect(result.direction).not.toBe("in_line");
      expect(result.line).toContain("based on 5 decisions");
      expect(result.line).not.toContain("based on 14 decisions");
      expect(result.line).not.toContain("14");
    }
  });

  it("the in_line line never names over or under, and cites the overall n (there is no single bucket's rate to misattribute)", () => {
    const rows = [
      ...Array.from({ length: 7 }, () => row(0.7, "stated", "right" as const)),
      ...Array.from({ length: 3 }, () => row(0.7, "stated", "wrong" as const)),
    ];
    const result = calibrate(rows, GATES);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.direction).toBe("in_line");
      expect(result.line).toBe("So far, your confidence roughly matches how things turned out, based on 10 decisions.");
      expect(result.line).not.toMatch(/over|under/i);
    }
  });

  it("the topic line names a direction in plain words, carries n, and never a bare percentage", () => {
    const hiring = [
      row(0.9, "stated", "right" as const, ["hiring"]),
      ...Array.from({ length: 5 }, () => row(0.9, "stated", "wrong" as const, ["hiring"])),
    ];
    const other = Array.from({ length: 4 }, () => row(0.7, "stated", "right" as const));
    const result = calibrate([...hiring, ...other], GATES);
    expect(result.ready).toBe(true);
    if (result.ready && result.topic) {
      expect(result.topic.direction).toBe("over");
      expect(result.topicLine).toBe("On hiring, your calls have come true less often than you expected so far, based on 6 decisions.");
      expect(result.topicLine).not.toMatch(/%/);
    }
  });
});
