import { describe, it, expect } from "vitest";
import { scoreCandidate, normalisePair, type ScorableEntry } from "../../src/insight/score";

const DAY = 86400000;
const at = (over: Partial<ScorableEntry> = {}): ScorableEntry => ({
  id: "x", tags: ["pricing"], importance: 3, createdAt: 0, ...over,
});

describe("normalisePair()", () => {
  it("orders ids so the same pair is one pair", () => {
    expect(normalisePair("b", "a")).toEqual(["a", "b"]);
    expect(normalisePair("a", "b")).toEqual(["a", "b"]);
  });
});

describe("scoreCandidate()", () => {
  it("rises with the time gap at equal similarity", () => {
    const near = scoreCandidate(at(), at({ createdAt: 40 * DAY }), 0.85);
    const far = scoreCandidate(at(), at({ createdAt: 200 * DAY }), 0.85);
    expect(far).toBeGreaterThan(near);
  });

  it("rises with importance", () => {
    const low = scoreCandidate(at({ importance: 1 }), at({ createdAt: 40 * DAY, importance: 1 }), 0.85);
    const high = scoreCandidate(at({ importance: 5 }), at({ createdAt: 40 * DAY, importance: 1 }), 0.85);
    expect(high).toBeGreaterThan(low);
  });

  it("promotes pairs that share no topic tag", () => {
    const shared = scoreCandidate(
      at({ tags: ["pricing"] }),
      at({ tags: ["pricing"], createdAt: 40 * DAY }), 0.85);
    const cross = scoreCandidate(
      at({ tags: ["pricing"] }),
      at({ tags: ["hiring"], createdAt: 40 * DAY }), 0.85);
    expect(cross).toBeGreaterThan(shared);
  });

  it("does not treat a shared axis tag as a shared topic", () => {
    const onlyAxisShared = scoreCandidate(
      at({ tags: ["work", "pricing"] }),
      at({ tags: ["work", "hiring"], createdAt: 40 * DAY }), 0.85);
    const trulyShared = scoreCandidate(
      at({ tags: ["work", "pricing"] }),
      at({ tags: ["work", "pricing"], createdAt: 40 * DAY }), 0.85);
    expect(onlyAxisShared).toBeGreaterThan(trulyShared);
  });

  it("demotes successive measurements of the same quantity", () => {
    const plain = scoreCandidate(
      at({ tags: ["metrics"] }),
      at({ tags: ["metrics"], createdAt: 40 * DAY }), 0.9);
    const stateful = scoreCandidate(
      at({ tags: ["metrics", "volatility:state"] }),
      at({ tags: ["metrics", "volatility:state"], createdAt: 40 * DAY }), 0.9);
    expect(stateful).toBeLessThan(plain);
  });

  it("does not demote when only one side is stateful", () => {
    const oneSided = scoreCandidate(
      at({ tags: ["metrics", "volatility:state"] }),
      at({ tags: ["metrics"], createdAt: 40 * DAY }), 0.9);
    const plain = scoreCandidate(
      at({ tags: ["metrics"] }),
      at({ tags: ["metrics"], createdAt: 40 * DAY }), 0.9);
    expect(oneSided).toBe(plain);
  });
});
