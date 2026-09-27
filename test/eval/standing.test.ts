import { expect, it } from "vitest";
import { scoreStandingPairs } from "./standing";

it("counts wrong standing fires and missed expected fires at a cosine threshold", () => {
  const pairs = [
    { expected: new Set(["a"]), scores: [{ id: "a", value: 0.8 }, { id: "b", value: 0.6 }, { id: "c", value: 0.5 }] },
    { expected: new Set<string>(), scores: [{ id: "b", value: 0.75 }] },
    { expected: new Set(["c"]), scores: [{ id: "a", value: 0.7 }, { id: "c", value: 0.4 }] },
  ];
  expect(scoreStandingPairs(pairs, [0.7])).toEqual([{ threshold: 0.7, precision: 1 / 3, recall: 1 / 2, truePositive: 1, falsePositive: 2, falseNegative: 1 }]);
  expect(scoreStandingPairs(pairs, [0.9])[0]).toMatchObject({ precision: 0, recall: 0, truePositive: 0, falsePositive: 0, falseNegative: 2 });
});
